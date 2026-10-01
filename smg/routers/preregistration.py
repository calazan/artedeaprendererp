from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..auth import get_client_ip
from ..preregistration import (
    configured,
    consume_rate_limit,
    counts,
    create_record,
    find_recent_duplicate,
    list_records,
    update_record,
)
from ..security import legacy_internal_authorized

logger = logging.getLogger("smg.routers.preregistration")
INTERNAL_ERROR_MESSAGE = "Ocorreu um erro interno ao processar a solicitação. Tente novamente mais tarde."
router = APIRouter()


def response(payload: dict, status: int = 200):
    return JSONResponse(
        payload,
        status_code=status,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
        },
    )


def text(value, max_len=300):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:max_len]


def multiline(value, max_len=2500):
    return str(value if value is not None else "").replace("\r", "").strip()[:max_len]


def digits(value, max_len=20):
    return "".join(ch for ch in str(value if value is not None else "") if ch.isdigit())[:max_len]


def boolean(value):
    return value is True or value in ("true", "yes", "sim", 1)


def valid_date(value=""):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value)):
        return False
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").strftime("%Y-%m-%d") == str(value)
    except Exception:
        return False


def valid_cpf(value=""):
    cpf = digits(value, 11)
    if len(cpf) != 11 or len(set(cpf)) == 1:
        return False

    def calc(length):
        total = sum(int(cpf[i]) * (length + 1 - i) for i in range(length))
        remainder = (total * 10) % 11
        return 0 if remainder == 10 else remainder

    return calc(9) == int(cpf[9]) and calc(10) == int(cpf[10])


def normalize_authorized_people(value):
    if not isinstance(value, list):
        return []
    rows = []
    for person in value[:10]:
        person = person if isinstance(person, dict) else {}
        row = {
            "name": text(person.get("name"), 160),
            "relationship": text(person.get("relationship"), 80),
            "phone": text(person.get("phone"), 30),
            "document": text(person.get("document"), 40),
        }
        if row["name"] or row["phone"]:
            rows.append(row)
    return rows


def client_ip(request: Request) -> str:
    return get_client_ip(request)


async def within_rate_limit(request: Request) -> bool:
    return await consume_rate_limit(
        client_ip(request),
        namespace="pre-registration-public",
        limit=5,
        window_seconds=10 * 60,
        fail_open=False,
    )


def protocol():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    random = secrets.token_hex(4)[:6].upper()
    return f"SM-{stamp}-{random}"


async def read_body(request: Request):
    raw = await request.body()
    if len(raw) > 1024 * 1024:
        return {}
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def normalize_submission(body: dict, request: Request):
    child_name = text(body.get("childName"), 160)
    birth_date = text(body.get("birthDate"), 10)
    guardian_name = text(body.get("guardianName"), 160)
    guardian_cpf = text(body.get("guardianCpf"), 20)
    guardian_phone = text(body.get("guardianPhone"), 30)
    emergency_name = text(body.get("emergencyName"), 160)
    emergency_phone = text(body.get("emergencyPhone"), 30)
    address = body.get("address") if isinstance(body.get("address"), dict) else {}
    consents = body.get("consents") if isinstance(body.get("consents"), dict) else {}

    errors = []
    if len(child_name) < 3:
        errors.append("Informe o nome completo da criança.")
    if not valid_date(birth_date):
        errors.append("Informe uma data de nascimento válida.")
    if len(guardian_name) < 3:
        errors.append("Informe o nome do responsável.")
    if not valid_cpf(guardian_cpf):
        errors.append("Informe um CPF válido para o responsável.")
    if len(digits(guardian_phone)) < 10:
        errors.append("Informe um telefone com WhatsApp válido.")
    if not text(body.get("relationship"), 80):
        errors.append("Informe o vínculo do responsável com a criança.")
    if len(digits(address.get("cep"))) != 8:
        errors.append("Informe um CEP válido.")
    if not text(address.get("street"), 180):
        errors.append("Informe a rua ou avenida.")
    if not text(address.get("number"), 30):
        errors.append("Informe o número do endereço.")
    if not text(address.get("district"), 120):
        errors.append("Informe o bairro.")
    if not text(address.get("city"), 120):
        errors.append("Informe a cidade.")
    if len(text(address.get("state"), 2)) != 2:
        errors.append("Informe o estado com duas letras.")
    if len(emergency_name) < 3:
        errors.append("Informe o contato de emergência.")
    if len(digits(emergency_phone)) < 10:
        errors.append("Informe um telefone de emergência válido.")
    if not text(body.get("emergencyRelationship"), 80):
        errors.append("Informe o vínculo do contato de emergência.")
    if not text(body.get("serviceInterest"), 120):
        errors.append("Informe o serviço de interesse.")
    if not boolean(consents.get("contact")):
        errors.append("É necessário autorizar o contato para concluir o envio.")
    if not boolean(consents.get("truth")):
        errors.append("É necessário confirmar que as informações são verdadeiras.")
    if not boolean(consents.get("storage")):
        errors.append("É necessário autorizar o armazenamento para realizar o pré-cadastro.")
    if not boolean(consents.get("responsibility")):
        errors.append("É necessário confirmar que o preenchimento foi feito por um responsável.")
    if not text(body.get("submitterName"), 160):
        errors.append("Informe o nome de quem está preenchendo.")

    image_authorization = text(body.get("imageAuthorization"), 40)
    if image_authorization not in {"internal-social", "internal-only", "none"}:
        errors.append("Escolha uma opção de autorização de imagem.")

    weekdays = (
        [text(item, 20) for item in body.get("weekdays", []) if text(item, 20)][:7]
        if isinstance(body.get("weekdays"), list)
        else []
    )

    data = {
        "childName": child_name,
        "birthDate": birth_date,
        "schoolName": text(body.get("schoolName"), 180),
        "schoolYear": text(body.get("schoolYear"), 80),
        "schoolPeriod": text(body.get("schoolPeriod"), 40),
        "guardianName": guardian_name,
        "guardianCpf": guardian_cpf,
        "relationship": text(body.get("relationship"), 80),
        "guardianPhone": guardian_phone,
        "secondPhone": text(body.get("secondPhone"), 30),
        "email": text(body.get("email"), 180).lower(),
        "profession": text(body.get("profession"), 120),
        "address": {
            "cep": text(address.get("cep"), 12),
            "street": text(address.get("street"), 180),
            "number": text(address.get("number"), 30),
            "complement": text(address.get("complement"), 120),
            "district": text(address.get("district"), 120),
            "city": text(address.get("city"), 120),
            "state": text(address.get("state"), 2).upper(),
        },
        "emergencyName": emergency_name,
        "emergencyRelationship": text(body.get("emergencyRelationship"), 80),
        "emergencyPhone": emergency_phone,
        "emergencyAuthorizedPickup": boolean(body.get("emergencyAuthorizedPickup")),
        "hasAllergy": boolean(body.get("hasAllergy")),
        "allergyDetails": multiline(body.get("allergyDetails"), 1500),
        "hasFoodRestriction": boolean(body.get("hasFoodRestriction")),
        "foodRestrictionDetails": multiline(body.get("foodRestrictionDetails"), 1500),
        "usesMedication": boolean(body.get("usesMedication")),
        "medicationDetails": multiline(body.get("medicationDetails"), 1500),
        "hasHealthCondition": boolean(body.get("hasHealthCondition")),
        "healthConditionDetails": multiline(body.get("healthConditionDetails"), 2000),
        "diagnosisStatus": text(body.get("diagnosisStatus"), 60),
        "diagnosisDetails": multiline(body.get("diagnosisDetails"), 2000),
        "routineDetails": multiline(body.get("routineDetails"), 2500),
        "healthPlan": text(body.get("healthPlan"), 180),
        "preferredHospital": text(body.get("preferredHospital"), 180),
        "authorizedPeople": normalize_authorized_people(body.get("authorizedPeople")),
        "hasUnauthorizedPerson": boolean(body.get("hasUnauthorizedPerson")),
        "unauthorizedPersonDetails": multiline(body.get("unauthorizedPersonDetails"), 1200),
        "serviceInterest": text(body.get("serviceInterest"), 120),
        "otherService": text(body.get("otherService"), 160),
        "weekdays": weekdays,
        "expectedStartDate": text(body.get("expectedStartDate"), 10) if valid_date(text(body.get("expectedStartDate"), 10)) else "",
        "referralSource": text(body.get("referralSource"), 100),
        "referralOther": text(body.get("referralOther"), 160),
        "imageAuthorization": image_authorization,
        "submitterName": text(body.get("submitterName"), 160),
        "consents": {
            "contact": boolean(consents.get("contact")),
            "truth": boolean(consents.get("truth")),
            "storage": boolean(consents.get("storage")),
            "responsibility": boolean(consents.get("responsibility")),
        },
        "submittedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "public-parent-form",
        "userAgent": text(request.headers.get("user-agent"), 300),
    }
    return errors, data


@router.api_route("/api/pre-registration", methods=["GET", "POST", "PATCH"])
async def preregistration_api(request: Request):
    if not configured():
        return response({"ok": False, "error": "O banco de dados ainda não está configurado."}, 503)
    try:
        if request.method == "POST":
            body = await read_body(request)
            if text(body.get("website"), 200):
                return response({"ok": True, "protocol": protocol(), "status": "pending"}, 201)
            if not await within_rate_limit(request):
                return response({"ok": False, "error": "Muitas tentativas. Aguarde alguns minutos e tente novamente."}, 429)

            errors, data = normalize_submission(body, request)
            if errors:
                return response({"ok": False, "error": errors[0], "errors": errors}, 400)

            duplicate = await find_recent_duplicate(
                data["childName"], data["birthDate"], data["guardianPhone"]
            )
            if duplicate:
                return response(
                    {
                        "ok": True,
                        "duplicate": True,
                        "protocol": duplicate["protocol"],
                        "status": duplicate["status"],
                        "message": "Este pré-cadastro já foi recebido e continua em análise.",
                    }
                )

            record = await create_record(str(uuid.uuid4()), protocol(), data)
            return response({"ok": True, "protocol": record["protocol"], "status": record["status"]}, 201)

        if not await legacy_internal_authorized(request):
            return response({"ok": False, "error": "Autenticação obrigatória."}, 401)

        if request.method == "GET":
            status = text(request.query_params.get("status"), 30)
            records = await list_records(status, request.query_params.get("limit"))
            return response({"ok": True, "records": records, "counts": await counts()})

        body = await read_body(request)
        record_id = text(body.get("id"), 80)
        status = text(body.get("status"), 30)
        if not record_id:
            return response({"ok": False, "error": "Identificador não informado."}, 400)
        record = await update_record(
            record_id,
            status,
            body.get("data") if isinstance(body.get("data"), dict) else None,
            text(body.get("enrolledStudentId"), 100),
        )
        return response({"ok": True, "record": record, "counts": await counts()})
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)


@router.get("/api/pre-registration-health")
async def preregistration_health():
    if not configured():
        return response({"ok": False, "schemaReady": False, "error": "Supabase não configurado."}, 503)
    try:
        await counts()
        return response({"ok": True, "schemaReady": True})
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "schemaReady": False, "error": INTERNAL_ERROR_MESSAGE}, 500)
