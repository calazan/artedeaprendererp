from __future__ import annotations

from fastapi.responses import HTMLResponse

PAGE = r"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#123b63"><title>Arte de Aprender ERP</title>
<style>
:root{--navy:#123b63;--blue:#1e6aa8;--gold:#f0a529;--bg:#f4f7fb;--text:#182433;--muted:#657286;--line:#dfe6ef;--ok:#17845b;--danger:#bd3434}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
button,input,select,textarea{font:inherit}.app{min-height:100vh;display:grid;grid-template-columns:250px 1fr}
aside{background:linear-gradient(180deg,#0e3153,#164d79);color:#fff;padding:24px 16px;position:sticky;top:0;height:100vh}
.brand{font-size:24px;font-weight:800;padding:4px 12px 24px}.brand span{color:var(--gold)}nav button{display:block;width:100%;border:0;background:transparent;color:#dceafa;text-align:left;padding:12px 14px;border-radius:10px;cursor:pointer;margin:3px 0}
nav button:hover,nav button.active{background:#ffffff1b;color:#fff}.user{position:absolute;bottom:20px;left:16px;right:16px;padding:14px;background:#ffffff12;border-radius:12px}
.user small{display:block;color:#bcd0e2}.logout{margin-top:10px;border:1px solid #ffffff44;background:transparent;color:#fff;padding:7px 10px;border-radius:8px;cursor:pointer}
main{padding:28px;min-width:0}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}.top h1{font-size:26px;margin:0}.status{padding:7px 11px;border-radius:99px;background:#e2f5ed;color:var(--ok);font-weight:700}
.grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:16px}.card,.panel{background:#fff;border:1px solid var(--line);border-radius:15px;box-shadow:0 5px 20px #1830490a}
.card{padding:19px}.card b{font-size:28px;display:block;margin-top:5px}.card span{color:var(--muted)}
.panel{padding:20px;margin-top:18px}.panel-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px}.panel h2{margin:0;font-size:19px}
.primary{border:0;background:var(--blue);color:#fff;padding:10px 14px;border-radius:9px;cursor:pointer;font-weight:700}.secondary{border:1px solid var(--line);background:#fff;padding:9px 12px;border-radius:9px;cursor:pointer}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase}.empty{padding:28px;text-align:center;color:var(--muted)}
.view{display:none}.view.active{display:block}.form{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;margin-bottom:15px}
input,select{width:100%;padding:10px 11px;border:1px solid #cbd5e1;border-radius:9px;background:#fff}.notice{padding:12px;border-radius:9px;margin-bottom:14px;display:none}.notice.show{display:block}.notice.error{background:#feecec;color:var(--danger)}.notice.ok{background:#e8f7f0;color:var(--ok)}
.mobile{display:none}@media(max-width:850px){.app{display:block}aside{height:auto;position:relative;padding:12px}.brand{padding:5px 8px 12px}.user{display:none}nav{display:flex;overflow:auto;gap:5px}nav button{white-space:nowrap;width:auto}.grid{grid-template-columns:repeat(2,1fr)}main{padding:18px}.form{grid-template-columns:1fr}.mobile{display:block}}
</style>
</head>
<body><div class="app">
<aside><div class="brand">Saber<span>+</span> Gestão</div>
<nav>
<button data-view="dashboard" class="active">Visão geral</button>
<button data-view="tasks">Tarefas</button>
<button data-view="employees">Funcionários</button>
<button data-view="attendance">Chamada</button>
<button data-view="system">Sistema</button>
</nav>
<div class="user"><strong id="userName">Usuário</strong><small id="userRole"></small><button class="logout" id="logout">Sair</button></div>
</aside>
<main>
<div id="notice" class="notice"></div>
<section id="dashboard" class="view active"><div class="top"><h1>Visão geral</h1><span class="status" id="systemStatus">Verificando…</span></div>
<div class="grid">
<div class="card"><span>Tarefas</span><b id="taskCount">—</b></div>
<div class="card"><span>Funcionários</span><b id="employeeCount">—</b></div>
<div class="card"><span>Banco de dados</span><b id="dbState">—</b></div>
<div class="card"><span>Backend</span><b>Python</b></div>
</div>
<div class="panel"><h2>Ambiente independente</h2><p>Esta interface e todas as APIs são entregues pelo projeto Python. Nenhum HTML é carregado de outro repositório ou domínio.</p></div>
</section>
<section id="tasks" class="view"><div class="top"><h1>Tarefas</h1><button class="secondary" onclick="loadTasks()">Atualizar</button></div>
<div class="panel"><form id="taskForm" class="form"><input id="taskTitle" placeholder="Descrição da tarefa" required><input id="taskDate" type="date" required><select id="taskPriority"><option value="normal">Normal</option><option value="high">Alta</option><option value="low">Baixa</option></select><button class="primary" type="submit">Adicionar tarefa</button></form>
<div id="taskTable" class="empty">Carregando…</div></div></section>
<section id="employees" class="view"><div class="top"><h1>Funcionários</h1><button class="secondary" onclick="loadEmployees()">Atualizar</button></div><div class="panel"><div id="employeeTable" class="empty">Carregando…</div></div></section>
<section id="attendance" class="view"><div class="top"><h1>Chamada</h1></div><div class="panel"><h2>Controle de presença</h2><p>A chamada usa diretamente o endpoint Python protegido.</p><button class="primary" id="loadAttendance">Carregar chamada de hoje</button><pre id="attendanceData" class="empty"></pre></div></section>
<section id="system" class="view"><div class="top"><h1>Sistema</h1></div><div class="panel"><h2>Estado do backend</h2><pre id="systemData" class="empty">Carregando…</pre></div></section>
</main></div>
<script>
const $=id=>document.getElementById(id); const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notify(message,type='ok'){const n=$('notice');n.textContent=message;n.className='notice show '+type;setTimeout(()=>n.className='notice',4500)}
async function api(url,options={}){const response=await fetch(url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await response.json()}catch{}if(response.status===401){location.replace('/login?next=/');throw new Error('Sessão expirada.')}if(!response.ok)throw new Error(data.error||'Falha na operação.');return data}
async function init(){try{const session=await api('/api/auth/session');$('userName').textContent=session.name||'Usuário';$('userRole').textContent=session.role||'';await Promise.allSettled([loadHealth(),loadTasks(),loadEmployees()])}catch(e){console.error(e)}}
async function loadHealth(){const [health,runtime]=await Promise.all([api('/api/health'),api('/api/runtime-mode')]);$('systemStatus').textContent=health.ok?'Sistema online':'Atenção';$('dbState').textContent=health.schemaReady?'Pronto':'Atenção';$('systemData').textContent=JSON.stringify({saude:health,execucao:runtime},null,2)}
function rowsOf(data,keys){for(const k of keys)if(Array.isArray(data[k]))return data[k];return[]}
async function loadTasks(){try{const data=await api('/api/tasks');const rows=rowsOf(data,['tasks','items','records']).filter(x=>!x.deletedAt);$('taskCount').textContent=rows.length;$('taskTable').innerHTML=rows.length?'<table><thead><tr><th>Tarefa</th><th>Data</th><th>Prioridade</th><th></th></tr></thead><tbody>'+rows.map(t=>'<tr><td>'+esc(t.title||t.name)+'</td><td>'+esc(t.date||'')+'</td><td>'+esc(t.priority||'normal')+'</td><td><button class="secondary" onclick="deleteTask(\''+esc(t.id)+'\')">Excluir</button></td></tr>').join('')+'</tbody></table>':'<div class="empty">Nenhuma tarefa cadastrada.</div>'}catch(e){$('taskTable').textContent=e.message;notify(e.message,'error')}}
async function deleteTask(id){if(!confirm('Excluir esta tarefa?'))return;try{await api('/api/tasks',{method:'DELETE',body:JSON.stringify({id})});notify('Tarefa excluída.');loadTasks()}catch(e){notify(e.message,'error')}}
$('taskForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/tasks',{method:'POST',body:JSON.stringify({task:{title:$('taskTitle').value,date:$('taskDate').value,priority:$('taskPriority').value,type:'task',active:true,timezone:'America/Sao_Paulo'}})});e.target.reset();$('taskDate').value=new Date().toISOString().slice(0,10);notify('Tarefa adicionada.');loadTasks()}catch(err){notify(err.message,'error')}})
async function loadEmployees(){try{const data=await api('/api/employees');const rows=rowsOf(data,['employees','items','records']);$('employeeCount').textContent=rows.length;$('employeeTable').innerHTML=rows.length?'<table><thead><tr><th>Nome</th><th>Cargo</th><th>Contato</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(x.name||x.fullName)+'</td><td>'+esc(x.role||x.position||'')+'</td><td>'+esc(x.phone||x.email||'')+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">Nenhum funcionário cadastrado.</div>'}catch(e){$('employeeTable').textContent=e.message}}
$('loadAttendance').onclick=async()=>{try{const d=await api('/api/teacher-attendance?date='+new Date().toISOString().slice(0,10));$('attendanceData').textContent=JSON.stringify(d,null,2)}catch(e){notify(e.message,'error')}}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));b.classList.add('active');$(b.dataset.view).classList.add('active')})
$('logout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});location.replace('/login')};$('taskDate').value=new Date().toISOString().slice(0,10);init();
</script></body></html>"""

def frontend_response() -> HTMLResponse:
    return HTMLResponse(PAGE, headers={
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        "X-SMG-Frontend-Source": "python-native",
    })
