"""Convierte el prototipo aprobado (Artifact) en la página de producción.

Uso: python3 scripts/port.py <prototipo.html> public/index.html
Cada reemplazo tiene que encontrar su texto exactamente una vez; si el prototipo
cambia, el script falla en vez de generar una página a medias.
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()


def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f"Esperaba {count} vez/veces y encontré {n}: {old[:90]!r}")
    s = s.replace(old, new)


# ---------- documento ----------
rep('<title>Scriptorium</title>\n<meta name="claude:viewport-fit-sides" content="cover">',
    '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<meta name="theme-color" content="#EDEEE9">\n<title>Scriptorium</title>\n'
    '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%229%22 fill=%22%23111%22/%3E%3Ctext x=%2216%22 y=%2222%22 font-family=%22Arial%22 font-weight=%22700%22 font-size=%2217%22 text-anchor=%22middle%22 fill=%22%23D6F35B%22%3ES%3C/text%3E%3C/svg%3E">\n'
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>')

GATE_CSS = """
/* ---------- acceso ---------- */
.gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.gate .card{width:100%;max-width:420px}
.gate .logo{margin:0 0 4px}
.gate form{display:flex;flex-direction:column;gap:14px}
.gate .err{color:var(--rfg,#9B2418);font-size:13px;font-weight:500;min-height:1em}
.gate .alt{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:13px}
.gate .alt button{background:none;border:0;padding:0;color:var(--muted2);text-decoration:underline;cursor:pointer;font:inherit}
.hidden{display:none!important}
"""
rep('@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}\n</style>',
    '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}\n' + GATE_CSS + '</style>\n</head>\n<body>')

rep('<div class="shell">', '<div id="gate" class="gate"><div class="card"><h2>Cargando Scriptorium…</h2></div></div>\n<div class="shell hidden" id="shell">')
rep('})();\n</script>', '})();\n</script>\n</body>\n</html>')

# ---------- capa de datos: Supabase ----------
rep("var S={products:[],found:[],lines:[],tasks:[],notes:[],events:[],chats:[],deliverables:[],config:null,loaded:{},live:false};\nvar db=null, sample=null, userCap=null;",
    "var S={products:[],found:[],lines:[],tasks:[],notes:[],events:[],chats:[],deliverables:[],members:[],config:null,loaded:{},live:true};\n"
    "var sb=null, SESSION=null, ME=null, channel=null, lastLoad=0;\n"
    "var ROAS={loaded:false,offers:[],rows:[],from:'',to:'',updatedAt:'',error:''};")
rep("me:lsGet('sc_me')||''};", "me:''};")
rep("function cfg(){var c=S.config||{};return {members:c.members&&c.members.length?c.members:['Anyelita','Nicole','NUCLEA'],goals:c.goals||[]};}",
    "function cfg(){var c=S.config||{};return {members:S.members.filter(function(m){return m.role!=='pendiente';}).map(function(m){return m.name;}),goals:c.goals||[]};}")

old_store_start = s.index("var store={")
old_store_end = s.index("function byId(col,id)")
s = s[:old_store_start] + r"""function rowToDoc(r){var d=r.data||{};return Object.assign({},d,{id:r.id,createdAt:d.createdAt||r.created_at});}
function upsertLocal(r){if(!r||COLS.indexOf(r.col)<0)return;var doc=rowToDoc(r);var arr=S[r.col];var i=arr.findIndex(function(x){return x.id===doc.id;});if(i>=0)arr[i]=doc;else arr.push(doc);}
function dropLocal(id){COLS.forEach(function(c){S[c]=S[c].filter(function(x){return x.id!==id;});});}
function chk(r){if(r&&r.error)throw r.error;return r;}
var store={
  add:function(col,data){data.createdAt=data.createdAt||new Date().toISOString();
    return sb.from('sc_items').insert({col:col,data:data}).select('id,col,data,created_at').single().then(chk).then(function(r){upsertLocal(r.data);scheduleRender();return r.data.id;}).catch(fail);},
  update:function(col,id,data){
    var it=byId(col,id);if(it)Object.assign(it,data);scheduleRender();
    return sb.rpc('sc_patch',{p_id:id,p_patch:data}).then(chk).catch(fail);},
  remove:function(col,id){
    dropLocal(id);scheduleRender();
    return sb.from('sc_items').delete().eq('id',id).then(chk).catch(fail);},
  setConfig:function(data){
    S.config=Object.assign({},S.config||{},data);scheduleRender();
    return sb.rpc('sc_patch_config',{p_patch:data}).then(chk).catch(fail);}
};
function fail(e){
  var m=String(e&&(e.message||e.code)||'');
  if(/permission|row-level|401|403|JWT/i.test(m))toast('No tienes permiso para guardar. Vuelve a iniciar sesión.');
  else toast('No se pudo guardar. Revisa tu conexión e intenta de nuevo.');
  console.warn(e);
}
""" + s[old_store_end:]

# ---------- ROAS real desde el NUCLEA Dashboard ----------
rep("function countriesText(cs){",
    "function pCountries(p){if(!p)return [];if(p.offer&&ROAS.loaded){return ROAS.rows.filter(function(r){return r.offer_id===p.offer;}).sort(function(a,b){return b.pauta-a.pauta;}).map(function(r){return {code:r.country,roas:r.roas};});}return p.countries||[];}\n"
    "function offerName(id){var o=ROAS.offers.find(function(x){return x.id===id;});return o?o.name:'';}\n"
    "function countriesText(cs){")
rep("'+((p.countries||[]).length?(p.countries||[]).map(chip).join(''):'<span class=\"chip n\"><span class=\"dot\"></span>Sin países</span>')+'</div></button>';",
    "'+(pCountries(p).length?pCountries(p).map(chip).join(''):'<span class=\"chip n\"><span class=\"dot\"></span>'+(p.offer?'Sin pauta en 3 días':'Sin países')+'</span>')+'</div></button>';")
rep("h+='<div class=\"chips\">'+((p.countries||[]).length?(p.countries||[]).map(chip).join(''):'<span class=\"chip n\"><span class=\"dot\"></span>Sin países</span>')",
    "h+='<div class=\"chips\">'+(pCountries(p).length?pCountries(p).map(chip).join(''):'<span class=\"chip n\"><span class=\"dot\"></span>'+(p.offer?'Sin pauta en 3 días':'Sin países')+'</span>')")
rep("var c=p&&p.countries&&p.countries[0];", "var c=p&&pCountries(p)[0];")
rep("Países y ROAS de los últimos 3 días: '+(countriesText(p.countries)||'sin datos')",
    "Países y ROAS de los últimos 3 días: '+(countriesText(pCountries(p))||'sin datos')")
rep("function legend(){return '<div class=\"legend\">",
    "function roasNote(){if(ROAS.error)return '<span style=\"color:var(--rfg,#9B2418)\">'+esc(ROAS.error)+'</span>';if(!ROAS.loaded)return 'Leyendo ROAS del Dashboard…';var t=new Date(ROAS.updatedAt);return 'ROAS del Dashboard, '+esc(shortDate(ROAS.from).toLowerCase())+' a '+esc(shortDate(ROAS.to).toLowerCase())+' · '+pad(t.getHours())+':'+pad(t.getMinutes());}\n"
    "function legend(){return '<div class=\"legend\"><span>'+roasNote()+'</span>")
rep("{name:'offer',label:'Oferta en el NUCLEA Dashboard',value:p.offer,hint:'para conectar el ROAS real más adelante'},\n    {name:'countries',label:'Países y ROAS de los últimos 3 días',value:countriesText(p.countries),hint:'ej.: CO 1.55, BO 1.21',placeholder:'CO 1.55, BO 1.21'},",
    "{name:'offer',label:'Oferta en el NUCLEA Dashboard',type:'select',value:p.offer||'',hint:'el ROAS por país se lee solo',options:[['','Sin conectar']].concat(ROAS.offers.filter(function(o){return !o.archived||o.id===p.offer;}).map(function(o){return [o.id,o.name];})).concat(p.offer&&!offerName(p.offer)?[[p.offer,'Oferta no encontrada']]:[])},\n"
    "    {name:'countries',label:'Países y ROAS a mano',value:countriesText(p.countries),hint:'solo si no está conectado a una oferta',placeholder:'CO 1.55, BO 1.21'},")

# ---------- banners ----------
rep("if(!S.live)h+='<div class=\"banner\">Vista sin conexión a los datos compartidos: lo que cambies aquí no se guarda. Abre el enlace con tu cuenta de Claude para trabajar en vivo.</div>';",
    "if(!S.live)h+='<div class=\"banner\">Se perdió la conexión en vivo. Lo que cambies se guarda, pero puede que no veas lo de los demás hasta reconectar.</div>';")

# ---------- cuenta y equipo ----------
old_who_start = s.index("function whoForm(){")
old_who_end = s.index("/* ---------- agents chat ---------- */")
s = s[:old_who_start] + r"""function whoForm(){
  if(!ME)return;
  var isAdmin=ME.role==='admin';
  var fields=[];
  if(isAdmin){
    S.members.slice().sort(function(a,b){return (a.role==='pendiente'?0:1)-(b.role==='pendiente'?0:1)||String(a.name).localeCompare(b.name);}).forEach(function(m){
      fields.push({name:'n_'+m.user_id,label:'Nombre',hint:m.email||'',value:m.name});
      fields.push({name:'r_'+m.user_id,label:'Acceso de '+m.name,type:'select',value:m.role,options:[['equipo','Equipo'],['admin','Admin'],['pendiente','Sin acceso (pendiente)']]});
    });
  }
  form({title:'Tu cuenta',intro:'Entraste como '+ME.name+(ME.email?' ('+ME.email+')':'')+'. '+(isAdmin?'Eres admin: aquí apruebas a quien se registra y cambias nombres.':'Si tu nombre está mal, pídele a un admin que lo cambie.'),
    fields:fields,submit:isAdmin?'Guardar equipo':'Listo',deleteLabel:'Cerrar sesión',
    onDelete:function(){sb.auth.signOut();return true;},
    onSubmit:function(v){
      if(!isAdmin)return true;
      var jobs=S.members.map(function(m){var n=(v['n_'+m.user_id]||'').trim()||m.name,r=v['r_'+m.user_id]||m.role;
        if(n===m.name&&r===m.role)return null;
        return sb.from('sc_members').update({name:n,role:r}).eq('user_id',m.user_id).then(chk);}).filter(Boolean);
      Promise.all(jobs).then(function(){if(jobs.length)toast('Equipo actualizado');return loadMembers();}).catch(function(e){toast(/admin/.test(String(e&&e.message))?'Scriptorium necesita al menos un admin':'No se pudo guardar el equipo');console.warn(e);});
      return true;}});
}

""" + s[old_who_end:]

# ---------- chat de agentes: Claude por la API ----------
old_chat_start = s.index("function sendChat(){")
old_chat_end = s.index("/* ---------- events ---------- */")
s = s[:old_chat_start] + r"""function sendChat(){
  var text=UI.draft.trim();if((!text&&!UI.atts.length)||UI.pending)return;
  var ag=agentById(UI.agent);var chat=UI.chatId&&byId('chats',UI.chatId);if(chat&&chat.agent!==ag.id)chat=null;
  var prod=chat?chat.product:UI.chatProduct;
  var texts=UI.atts.filter(function(a){return a.kind==='text';}),bins=UI.atts.filter(function(a){return a.kind!=='text';});
  var full=text;texts.forEach(function(a){full+='\n\n--- Archivo adjunto: '+a.name+' ---\n'+a.text;});
  var umsg={role:'user',content:text||'(ver adjuntos)',atts:UI.atts.map(function(a){return a.name;}),full:full,who:UI.me||'',at:new Date().toISOString()};
  var history=(chat?chat.messages||[]:[]).concat([umsg]);
  var turns=history.map(function(m,i){var t={role:m.role==='user'?'user':'assistant',text:m.full||m.content,who:m.role==='user'?m.who:undefined};
    if(i===history.length-1&&bins.length)t.attachments=bins.map(function(a){return {kind:a.kind,name:a.name,media_type:a.type,data:a.data};});return t;});
  UI.draft='';UI.atts=[];UI.pending=true;UI.streamText='';
  var p=chat?store.update('chats',chat.id,{messages:history,updatedAt:umsg.at}).then(function(){return chat.id;}):store.add('chats',{agent:ag.id,product:prod||'',title:(text||umsg.atts[0]||'Chat').slice(0,60),messages:history,updatedAt:umsg.at});
  var got='';
  p.then(function(id){
    if(!id)throw new Error('no-chat');
    UI.chatId=id;render();
    abortCtl=new AbortController();
    return api('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:ag.id,context:productContext(prod).trim(),messages:turns}),signal:abortCtl.signal,raw:true}).then(function(res){
      if(!res.ok)return res.json().catch(function(){return {};}).then(function(j){throw new Error(j.error||('HTTP '+res.status));});
      var reader=res.body.getReader(),dec=new TextDecoder();
      function pump(){return reader.read().then(function(r){if(r.done){got+=dec.decode();return;}got+=dec.decode(r.value,{stream:true});UI.streamText=got;
        var el=document.getElementById('streaming');if(el){el.textContent=got;var m=document.getElementById('msgs');if(m)m.scrollTop=m.scrollHeight;}return pump();});}
      return pump();
    }).then(function(){
      var c=byId('chats',id);var msgs=(c&&c.messages?c.messages:history).concat([{role:'assistant',content:got||'[Sin respuesta]',at:new Date().toISOString()}]);
      UI.pending=false;return store.update('chats',id,{messages:msgs,updatedAt:new Date().toISOString()});
    }).catch(function(e){
      UI.pending=false;
      if(e&&e.name==='AbortError')toast('Detenido');else toast(e&&e.message&&e.message!=='no-chat'&&e.message.length<120?e.message:'El agente no pudo responder. Intenta de nuevo.');
      if(got){var cc=byId('chats',id);if(cc)store.update('chats',cc.id,{messages:(cc.messages||[]).concat([{role:'assistant',content:got+'\n\n[Incompleto]',at:new Date().toISOString()}])});}
    });
  }).catch(function(e){UI.pending=false;console.warn(e);toast('No se pudo iniciar el chat.');}).then(function(){render();});
}
var IMG_TYPES=['image/jpeg','image/png','image/gif','image/webp'];
function readFiles(files){
  Array.prototype.forEach.call(files,function(f){
    var isPdf=f.type==='application/pdf'||/\.pdf$/i.test(f.name),isImg=IMG_TYPES.indexOf(f.type)>=0;
    if(isImg||isPdf){
      var max=isImg?5:20;if(f.size>max*1024*1024){toast(f.name+' pesa más de '+max+' MB');return;}
      var r=new FileReader();r.onload=function(){var d=String(r.result);UI.atts.push({kind:isImg?'image':'pdf',name:f.name,type:isImg?f.type:'application/pdf',data:d.slice(d.indexOf(',')+1)});render();};r.readAsDataURL(f);return;
    }
    if(/^(image|video|audio)\//.test(f.type)){toast(f.type.indexOf('image')===0?'Usa imágenes JPG, PNG, GIF o WebP':'Audio y video llegan en la siguiente fase');return;}
    if(f.size>400*1024){toast(f.name+' es muy grande para el chat');return;}
    var t=new FileReader();t.onload=function(){UI.atts.push({kind:'text',name:f.name,text:String(t.result)});render();};t.readAsText(f);
  });
}

""" + s[old_chat_end:]

rep("else if(c==='atttext'){readFiles(el.files,'text');}\n  else if(c==='attimg'){if(!UI.imagesOk){toast('Las imágenes no están disponibles aquí. Adjunta texto.');return;}readFiles(el.files,'img');}",
    "else if(c==='atttext'||c==='attimg'){readFiles(el.files);el.value='';}")
rep("accept=\".txt,.md,.csv,.json,.srt,text/*\" multiple hidden>", "accept=\".pdf,.txt,.md,.csv,.json,.srt,application/pdf,text/*\" multiple hidden>")
rep("title=\"Adjuntar texto\">'+ic('doc',18)+'<span class=\"sr\">Adjuntar documento de texto</span>",
    "title=\"Adjuntar PDF o texto\">'+ic('doc',18)+'<span class=\"sr\">Adjuntar PDF o documento de texto</span>")
rep("ic(a.kind==='img'?'img':'doc',14)", "ic(a.kind==='image'?'img':'doc',14)")
rep("'<button type=\"submit\" class=\"btn dark\"'+(sample?'':' disabled title=\"El chat necesita abrir la página con tu cuenta de Claude\"')+'>Enviar</button>'",
    "'<button type=\"submit\" class=\"btn dark\">Enviar</button>'")
rep("Puedes adjuntar textos (.txt, .md, .csv) e imágenes.", "Puedes adjuntar PDF, textos (.txt, .md, .csv) e imágenes.")
rep("Por ahora el chat acepta texto, documentos de texto e imágenes. Video y audio llegan en la siguiente versión.",
    "El chat acepta texto, PDF, documentos de texto e imágenes. Audio y video llegan en la siguiente fase.")

# ---------- arranque: login + datos en vivo ----------
old_boot_start = s.index("/* ---------- boot ---------- */")
old_boot_end = s.index("var rq=null;function scheduleRender()")
s = s[:old_boot_start] + r"""/* ---------- boot ---------- */
function api(path,opts){
  opts=opts||{};var raw=opts.raw;delete opts.raw;
  return sb.auth.getSession().then(function(r){
    var tok=r.data&&r.data.session&&r.data.session.access_token;
    opts.headers=Object.assign({},opts.headers||{},tok?{Authorization:'Bearer '+tok}:{});
    return fetch(path,opts);
  }).then(function(res){if(raw)return res;return res.json().catch(function(){return {};}).then(function(j){if(!res.ok){var e=new Error(j.error||('HTTP '+res.status));e.status=res.status;throw e;}return j;});});
}
var gateMode='login',gateMsg='',gateEmail='';
function showGate(mode,msg){
  gateMode=mode;gateMsg=msg||'';
  document.getElementById('shell').classList.add('hidden');
  var g=document.getElementById('gate');g.classList.remove('hidden');
  var h='<div class="card"><div class="logo" aria-hidden="true">S</div>';
  if(mode==='loading')h+='<h2>Cargando Scriptorium…</h2><p class="sub" style="margin:0">Conectando con los datos del equipo.</p>';
  else if(mode==='error')h+='<h2>No se pudo abrir Scriptorium</h2><p class="sub" style="margin:0">'+esc(gateMsg||'Revisa tu conexión y recarga la página.')+'</p><button class="btn dark" onclick="location.reload()">Recargar</button>';
  else if(mode==='pending')h+='<h2>Tu acceso está pendiente</h2><p class="sub" style="margin:0">Ya creaste tu cuenta'+(ME?' como '+esc(ME.name):'')+'. Un admin del equipo tiene que aprobarte desde su cuenta en Scriptorium. Cuando lo haga, recarga esta página.</p><div class="alt"><button type="button" data-g="reload">Ya me aprobaron</button><button type="button" data-g="logout">Cerrar sesión</button></div>';
  else if(mode==='reset')h+='<h2>Nueva contraseña</h2><form data-f="gate"><label class="field" for="g_pw">Contraseña nueva <span class="hint">mínimo 8 caracteres</span><input id="g_pw" name="password" type="password" minlength="8" required autocomplete="new-password"></label><div class="err" role="alert">'+esc(gateMsg)+'</div><button class="btn dark" type="submit">Guardar contraseña</button></form>';
  else{
    var up=mode==='signup',forgot=mode==='forgot';
    h+='<h2>'+(up?'Crear cuenta':forgot?'Recuperar contraseña':'Entrar a Scriptorium')+'</h2><form data-f="gate">';
    if(up)h+='<label class="field" for="g_name">Tu nombre<input id="g_name" name="name" required autocomplete="name" placeholder="Como te conoce el equipo"></label>';
    h+='<label class="field" for="g_email">Correo<input id="g_email" name="email" type="email" required autocomplete="email" value="'+esc(gateEmail)+'"></label>';
    if(!forgot)h+='<label class="field" for="g_pw">Contraseña'+(up?' <span class="hint">mínimo 8 caracteres</span>':'')+'<input id="g_pw" name="password" type="password" '+(up?'minlength="8" ':'')+'required autocomplete="'+(up?'new-password':'current-password')+'"></label>';
    h+='<div class="err" role="alert">'+esc(gateMsg)+'</div><button class="btn dark" type="submit">'+(up?'Crear cuenta':forgot?'Enviarme el enlace':'Entrar')+'</button></form>';
    h+='<div class="alt">'+(up||forgot?'<button type="button" data-g="login">Ya tengo cuenta</button>':'<button type="button" data-g="signup">Crear cuenta</button><button type="button" data-g="forgot">Olvidé mi contraseña</button>')+'</div>';
  }
  g.innerHTML=h+'</div>';
  var f=g.querySelector(gateEmail&&mode==='login'?'#g_pw':'input');if(f)f.focus();
}
function hideGate(){document.getElementById('gate').classList.add('hidden');document.getElementById('shell').classList.remove('hidden');}
document.addEventListener('click',function(ev){var b=ev.target.closest('[data-g]');if(!b)return;var g=b.dataset.g;
  if(g==='logout'){sb.auth.signOut();return;}if(g==='reload'){location.reload();return;}showGate(g);});
document.addEventListener('submit',function(ev){
  var f=ev.target;if(f.dataset.f!=='gate')return;ev.preventDefault();
  var v=fdObj(f);if(v.email)gateEmail=v.email;var btn=f.querySelector('button[type=submit]');btn.disabled=true;
  var p;
  if(gateMode==='signup')p=sb.auth.signUp({email:v.email,password:v.password,options:{data:{full_name:v.name},emailRedirectTo:location.origin}}).then(function(r){if(r.error)throw r.error;if(!r.data.session)showGate('login','Te enviamos un correo para confirmar tu cuenta. Ábrelo y luego entra aquí.');});
  else if(gateMode==='forgot')p=sb.auth.resetPasswordForEmail(v.email,{redirectTo:location.origin}).then(function(r){if(r.error)throw r.error;showGate('login','Si el correo existe, te llegó un enlace para crear una contraseña nueva.');});
  else if(gateMode==='reset')p=sb.auth.updateUser({password:v.password}).then(function(r){if(r.error)throw r.error;toast('Contraseña guardada');onSession(r.data&&SESSION,true);});
  else p=sb.auth.signInWithPassword({email:v.email,password:v.password}).then(function(r){if(r.error)throw r.error;});
  p.catch(function(e){var m=String(e&&e.message||'');
    var t=/Invalid login/i.test(m)?'Correo o contraseña incorrectos.':/not confirmed/i.test(m)?'Confirma tu correo antes de entrar (revisa tu bandeja).':/already registered/i.test(m)?'Ese correo ya tiene cuenta. Entra o recupera la contraseña.':/Password/i.test(m)?'La contraseña debe tener al menos 8 caracteres.':'No se pudo. '+m;
    showGate(gateMode,t);});
});

function loadAll(){
  var all=[],size=1000;
  function page(from){return sb.from('sc_items').select('id,col,data,created_at').order('created_at').range(from,from+size-1).then(chk).then(function(r){all=all.concat(r.data);return r.data.length===size?page(from+size):all;});}
  return Promise.all([page(0),sb.from('sc_config').select('data').eq('id','main').maybeSingle().then(chk),loadMembers()]).then(function(res){
    COLS.forEach(function(c){S[c]=[];S.loaded[c]=true;});
    res[0].forEach(upsertLocal);
    S.config=res[1].data?res[1].data.data:{};
    lastLoad=Date.now();scheduleRender();
  });
}
function loadMembers(){return sb.from('sc_members').select('user_id,email,name,role').order('name').then(chk).then(function(r){S.members=r.data||[];var me=ME&&S.members.find(function(m){return m.user_id===ME.user_id;});if(me){ME=me;UI.me=me.name;}scheduleRender();});}
function loadRoas(){return api('/api/roas').then(function(r){ROAS.offers=r.offers||[];ROAS.rows=r.rows||[];ROAS.from=r.from;ROAS.to=r.to;ROAS.updatedAt=r.updatedAt;ROAS.error=r.error||'';ROAS.loaded=!r.error||ROAS.rows.length>0;scheduleRender();}).catch(function(e){ROAS.error='No se pudo leer el ROAS del Dashboard.';console.warn(e);scheduleRender();});}
function subscribe(){
  if(channel)sb.removeChannel(channel);
  channel=sb.channel('scriptorium')
    .on('postgres_changes',{event:'*',schema:'public',table:'sc_items'},function(p){if(p.eventType==='DELETE'){dropLocal(p.old&&p.old.id);}else upsertLocal(p.new);scheduleRender();})
    .on('postgres_changes',{event:'*',schema:'public',table:'sc_config'},function(p){if(p.new&&p.new.id==='main'){S.config=p.new.data||{};scheduleRender();}})
    .on('postgres_changes',{event:'*',schema:'public',table:'sc_members'},function(){loadMembers();})
    .subscribe(function(status){var was=S.live;S.live=status==='SUBSCRIBED';if(S.live&&!was)loadAll();if(was!==S.live)scheduleRender();});
}
var roasTimer=null,booted=false;
function bootData(){
  hideGate();route();
  loadAll().then(function(){if(!booted){booted=true;subscribe();}}).catch(function(e){console.warn(e);showGate('error','No se pudieron leer los datos del equipo.');});
  loadRoas();clearInterval(roasTimer);roasTimer=setInterval(loadRoas,10*60*1000);
}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&ME&&ME.role!=='pendiente'&&Date.now()-lastLoad>5*60*1000){loadAll().catch(function(){});loadRoas();}});
function onSession(session,force){
  var prev=SESSION;SESSION=session;
  if(!session){ME=null;booted=false;if(channel){sb.removeChannel(channel);channel=null;}clearInterval(roasTimer);if(gateMode!=='reset')showGate('login');return;}
  if(!force&&prev&&prev.user&&prev.user.id===session.user.id&&ME)return;
  api('/api/me').then(function(me){ME=me;UI.me=me.name;if(me.role==='pendiente'){showGate('pending');return;}bootData();})
    .catch(function(e){if(e.status===401){sb.auth.signOut();return;}showGate('error','No se pudo verificar tu cuenta. '+e.message);});
}
function start(){
  showGate('loading');
  fetch('/api/config').then(function(r){return r.json();}).then(function(c){
    if(!c.supabaseUrl||!c.supabaseAnonKey)throw new Error('Falta configurar Supabase en Cloudflare.');
    sb=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey);
    sb.auth.onAuthStateChange(function(ev,session){setTimeout(function(){if(ev==='PASSWORD_RECOVERY'){SESSION=session;showGate('reset');return;}if(ev==='TOKEN_REFRESHED'){SESSION=session;return;}if(gateMode==='reset'&&session)return;onSession(session);},0);});
  }).catch(function(e){showGate('error',e.message);});
}
""" + s[old_boot_end:]

open(dst, "w", encoding="utf-8").write(s)
print("ok", len(s))
