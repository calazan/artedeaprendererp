from __future__ import annotations

from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from . import APP_VERSION
from . import task_store as _task_store
from .auth import router as auth_router
from .db import close_pool
from .push_compat import send_web_push as _compatible_send_web_push

# Patch the historical task-store sender before the tasks router imports it.
# This converts the existing VAPID scalar to PEM without rotating keys.
_task_store.send_web_push = _compatible_send_web_push

from .routers.attendance import router as attendance_router
from .routers.domains import router as domains_router
from .routers.employees import router as employees_router
from .routers.health import router as health_router
from .routers.integrity import router as integrity_router
from .routers.internal_cron import router as internal_cron_router
from .routers.preregistration import router as preregistration_router
from .routers.sync import router as sync_router
from .routers.tasks import router as tasks_router
from .routers.whatsapp import router as whatsapp_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await close_pool()


app = FastAPI(
    title="Arte de Aprender ERP — Python",
    version=APP_VERSION,
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

for router in (
    auth_router,
    health_router,
    integrity_router,
    sync_router,
    attendance_router,
    tasks_router,
    employees_router,
    domains_router,
    preregistration_router,
    whatsapp_router,
    internal_cron_router,
):
    app.include_router(router)


@app.get("/api/python-info")
async def python_info():
    return {
        "ok": True,
        "app": "Arte de Aprender ERP",
        "version": APP_VERSION,
        "backend": "python-fastapi",
        "frontendMode": "python-owned-bundled-ui",
        "externalFrontend": False,
        "businessLogic": "python",
        "database": "supabase-postgres",
    }
