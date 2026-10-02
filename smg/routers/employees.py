from __future__ import annotations

import base64
import json
import logging
import re
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..employees import (
    delete_employee_document,
    get_employee_document,
    list_employee_documents,
    list_employees,
    save_employee_document,
    sync_employees,
)
from ..security import legacy_internal_authorized

logger = logging.getLogger("smg.routers.employees")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()
MAX_FILE_BYTES = 3_000_000
MAX_DOCUMENT_BODY_BYTES = 4_250_000
ALLOWED_MIME = {"application/pdf", "image/jpeg", "image/png", "image/webp"}


def json_response(payload: dict, status: int = 200):
    return JSONResponse(
        payload,
        status_code=status,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


class PayloadTooLargeError(ValueError):
    pass


async def body_json(request: Request, max_bytes: int = 4 * 1024 * 1024) -> dict:
    raw = await request.body()
    if len(raw) > max_bytes:
        raise PayloadTooLargeError
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
        return value if isinstance(value, dict) else {}
    except PayloadTooLargeError:
        raise
    except Exception:
        return {}


def text(value="", max_len=300):
    return re.sub(r"[\x00-\x1f]", "", str(value if value is not None else "")).strip()[:max_len]


def safe_filename(value="arquivo"):
    return re.sub(r'[\\/:*?"<>|]', "-", text(value, 220)) or "arquivo"


@router.api_route("/api/employees", methods=["GET", "POST"])
async def employees_api(request: Request):
    if not await legacy_internal_authorized(request):
        return json_response({"ok": False, "error": "Chave interna inválida."}, 401)
    try:
        if request.method == "GET":
            employees = await list_employees()
            return json_response({"ok": True, "employees": employees, "count": len(employees)})
        body = await body_json(request, 4 * 1024 * 1024)
        result = await sync_employees(
            body.get("employees") if isinstance(body.get("employees"), list) else [],
            body.get("deletedIds") if isinstance(body.get("deletedIds"), list) else [],
        )
        return json_response({"ok": True, **result})
    except PayloadTooLargeError:
        return json_response({"ok": False, "error": "Payload de funcionários muito grande."}, 413)
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return json_response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)


@router.api_route("/api/employee-documents", methods=["GET", "POST", "DELETE"])
async def employee_documents_api(request: Request):
    if not await legacy_internal_authorized(request):
        return json_response({"ok": False, "error": "Chave interna inválida."}, 401)
    try:
        if request.method == "GET":
            document_id = text(request.query_params.get("id"), 120)
            if document_id:
                document = await get_employee_document(document_id)
                if not document:
                    return json_response({"ok": False, "error": "Documento não encontrado."}, 404)
                filename = safe_filename(document["filename"])
                return Response(
                    content=document["content"],
                    status_code=200,
                    media_type=document["mimeType"] or "application/octet-stream",
                    headers={
                        "Content-Length": str(len(document["content"])),
                        "Cache-Control": "private, no-store",
                        "X-Content-Type-Options": "nosniff",
                        "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}",
                    },
                )
            documents = await list_employee_documents(
                employee_id=text(request.query_params.get("employeeId"), 120),
                period=text(request.query_params.get("period"), 20),
                kind=text(request.query_params.get("kind"), 40),
            )
            return json_response({"ok": True, "documents": documents})

        if request.method == "DELETE":
            document_id = text(request.query_params.get("id"), 120)
            if not document_id:
                return json_response({"ok": False, "error": "Documento não informado."}, 400)
            deleted = await delete_employee_document(document_id)
            if not deleted:
                return json_response({"ok": False, "error": "Documento não encontrado."}, 404)
            return json_response({"ok": True, "deleted": deleted})

        body = await body_json(request, MAX_DOCUMENT_BODY_BYTES)
        employee_id = text(body.get("employeeId"), 120)
        filename = safe_filename(body.get("filename"))
        mime_type = text(body.get("mimeType"), 120).lower()
        raw_b64 = str(body.get("dataBase64") or "")
        raw_b64 = re.sub(r"^data:[^;]+;base64,", "", raw_b64)
        if not employee_id:
            return json_response({"ok": False, "error": "Selecione um funcionário."}, 400)
        if not raw_b64:
            return json_response({"ok": False, "error": "Arquivo não enviado."}, 400)
        if mime_type not in ALLOWED_MIME:
            return json_response({"ok": False, "error": "Envie PDF, JPG, PNG ou WEBP."}, 400)
        try:
            content = base64.b64decode(raw_b64, validate=False)
        except Exception:
            content = b""
        if not content:
            return json_response({"ok": False, "error": "Arquivo inválido."}, 400)
        if len(content) > MAX_FILE_BYTES:
            return json_response(
                {
                    "ok": False,
                    "error": (
                        "O arquivo deve ter no máximo 3 MB. O envio usa base64 dentro "
                        "de JSON e precisa permanecer abaixo do limite da plataforma."
                    ),
                },
                413,
            )

        document = await save_employee_document(
            {
                "id": str(uuid.uuid4()),
                "employeeId": employee_id,
                "kind": text(body.get("kind") or "other", 40),
                "period": text(body.get("period") or "", 20),
                "relatedId": text(body.get("relatedId") or "", 120),
                "filename": filename,
                "mimeType": mime_type,
                "content": content,
            }
        )
        return json_response({"ok": True, "document": document}, 201)
    except PayloadTooLargeError:
        return json_response(
            {
                "ok": False,
                "error": (
                    "O corpo do upload é grande demais. Use um arquivo de até 3 MB "
                    "em PDF, JPG, PNG ou WEBP."
                ),
            },
            413,
        )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return json_response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)
