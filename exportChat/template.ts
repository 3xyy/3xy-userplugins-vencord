/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Builds an export page from the viewer template: the data, highlights, optional password and admin
// tools. Pure (no Discord stores, no IPC), so a normal export (htmlGenerator.ts) and an uploaded file
// (exportUpload.ts) go through the same code, and _dev checks can run it.

/** PBKDF2 iterations for password-protected exports (OWASP 2023 guidance for PBKDF2-HMAC-SHA256). */
export const PBKDF2_ITERATIONS = 600_000;

/**
 * JSON that is safe inside an inline <script>: `<` is escaped so data can't close the script
 * (`</script>`) or open an HTML comment, and U+2028/U+2029 are escaped for older JS parsers.
 */
function scriptJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** The viewer's single module script (its whole app). */
export const MODULE_SCRIPT_RE = /<script type="module"[^>]*>/;

// DCEF pads all IDs to 24 chars
export function padId(id: string): string {
    return (id || "0").padStart(24, "0");
}

export async function injectIntoTemplate(template: string, dataObj: any, title: string, highlightedIds?: Set<string>, password?: string, adminMode?: boolean): Promise<string> {
    const highlightPaddedIds = highlightedIds ? [...highlightedIds].filter(id => /^\d+$/.test(id)).map(id => padId(id)) : [];
    const highlightCss = highlightPaddedIds.length > 0
        ? `<style>${highlightPaddedIds.map(id => `[data-id="${id}"]`).join(",")}{background:rgba(250,166,26,.12)!important;border-left:3px solid #faa61a!important}</style>`
        : "";

    const patchScript = `<script>
(function(){
  var op=history.pushState,or=history.replaceState;
  history.pushState=function(s,t,u){try{op.call(this,s,t,u)}catch(e){try{op.call(this,s,t)}catch(e2){}}};
  history.replaceState=function(s,t,u){try{or.call(this,s,t,u)}catch(e){try{or.call(this,s,t)}catch(e2){}}};
  var of=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'){
      if(u.startsWith('/api/'))return Promise.resolve(new Response('[]',{status:200}));
      // On a Pages site, CDN fetches fail CORS: answer with an empty response instead of an error
      if(u.includes('cdn.discordapp.com')||u.includes('media.discordapp.net')||u.includes('files.catbox.moe'))return of.apply(this,arguments).catch(function(){return new Response('',{status:200})});
    }
    return of.apply(this,arguments);
  };
})();
</script>`;

    let fullDataScript: string;

    if (password) {
        // Encrypt the data + highlighted IDs together
        const plaintext = JSON.stringify({ data: dataObj, highlightedIds: highlightPaddedIds });
        const enc = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
        const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
        // Chunked base64 to avoid stack overflow with large data
        const toB64 = (b: ArrayBuffer) => {
            const bytes = new Uint8Array(b);
            let binary = "";
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
            }
            return btoa(binary);
        };

        // Password-protected export. The viewer's app script is kept inert (type="text/plain", see
        // below) and started by __dcefBoot() once the data is decrypted, without reloading the page,
        // so the decrypted data never has to fit in sessionStorage. The sessionStorage copy is only
        // a best-effort cache that lets a reload (admin-mode edits) skip the password prompt.
        fullDataScript = `<script>
window.__DCEF_ENCRYPTED="${toB64(encrypted)}";
window.__DCEF_SALT="${toHex(salt)}";
window.__DCEF_IV="${toHex(iv)}";
function __dcefApply(json){
  var p=JSON.parse(json);
  // Admin-mode edits restored from sessionStorage take precedence over the original data
  if(!window.__adminState){window.__DCEF_DATA=p.data;if(p.highlightedIds)window.__DCEF_HIGHLIGHTED_IDS=p.highlightedIds;}
  window.__DCEF_UNLOCKED=true;
}
function __dcefBoot(){
  if(window.__DCEF_BOOTED)return;
  var s=document.getElementById('vc-dcef-app');
  if(!s)return;
  window.__DCEF_BOOTED=true;
  var o=document.getElementById('pw-overlay');if(o)o.remove();
  var n=document.createElement('script');n.type='module';n.textContent=s.textContent;
  s.parentNode.insertBefore(n,s.nextSibling);
}
(function(){
  var cached=null;
  try{cached=sessionStorage.getItem('__dcef_unlocked_'+window.__DCEF_EXPORT_ID);}catch(e){}
  if(!cached)return;
  try{__dcefApply(cached);}catch(e){window.__DCEF_UNLOCKED=false;try{sessionStorage.removeItem('__dcef_unlocked_'+window.__DCEF_EXPORT_ID);}catch(e2){}return;}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',__dcefBoot);else __dcefBoot();
})();
async function decryptExport(){
  var json;
  try{
    var pw=document.getElementById('pw-input').value;
    var enc=new TextEncoder();
    var salt=Uint8Array.from(window.__DCEF_SALT.match(/.{2}/g).map(function(b){return parseInt(b,16)}));
    var iv=Uint8Array.from(window.__DCEF_IV.match(/.{2}/g).map(function(b){return parseInt(b,16)}));
    var raw=Uint8Array.from(atob(window.__DCEF_ENCRYPTED),function(c){return c.charCodeAt(0)});
    var km=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveKey']);
    var key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:${PBKDF2_ITERATIONS},hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
    var dec=await crypto.subtle.decrypt({name:'AES-GCM',iv:iv},key,raw);
    json=new TextDecoder().decode(dec);
  }catch(e){
    document.getElementById('pw-error').style.display='block';
    document.getElementById('pw-input').value='';
    document.getElementById('pw-input').focus();
    return;
  }
  __dcefApply(json);
  try{sessionStorage.setItem('__dcef_unlocked_'+window.__DCEF_EXPORT_ID,json);}catch(e){/* over the quota: stays unlocked until reload */}
  __dcefBoot();
}
</script>`;
    } else {
        const highlightIdsScript = highlightPaddedIds.length > 0
            ? `window.__DCEF_HIGHLIGHTED_IDS=${scriptJson(highlightPaddedIds)};`
            : "";
        fullDataScript = `<script>window.__DCEF_DATA=${scriptJson(dataObj)};${highlightIdsScript}</script>`;
    }

    // Function replacements everywhere: a string replacement would expand `$&`, `$'`, `` $` `` and `$$`
    // found in message text.
    // Per-export id: keys this export's sessionStorage entries (file:// pages share one origin, so a
    // fixed key would hand one export's decrypted data / admin edits to the next export opened in the tab)
    const exportId = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
    const idScript = `<script>window.__DCEF_EXPORT_ID="${exportId}";</script>`;
    const injected = idScript + "\n" + highlightCss + "\n" + patchScript + "\n" + fullDataScript + "\n";
    let html = template;
    if (MODULE_SCRIPT_RE.test(html)) {
        html = html.replace(MODULE_SCRIPT_RE, tag => injected + (password ? '<script type="text/plain" id="vc-dcef-app">' : tag));
    } else {
        html = html.replace("</head>", () => injected + "</head>");
    }
    html = html.replace("<title>DCE-Frontend</title>", () => `<title>Export: ${escapeHtml(title)}</title>`);

    // For password-protected exports, inject the overlay into <body>
    if (password) {
        const overlay = "<div id=\"pw-overlay\" style=\"position:fixed;top:0;left:0;width:100%;height:100%;background:#1e1f22;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:gg sans,Noto Sans,sans-serif\"><div style=\"text-align:center;color:#dbdee1\"><div style=\"font-size:48px;margin-bottom:16px\">&#128274;</div><div style=\"font-size:20px;font-weight:600;margin-bottom:8px\">This export is password protected</div><div style=\"font-size:14px;color:#949ba4;margin-bottom:16px\">Enter the password to view messages</div><input id=\"pw-input\" type=\"password\" placeholder=\"Password\" autocomplete=\"off\" style=\"background:#313338;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:10px 16px;font-size:16px;width:280px;outline:none;font-family:inherit\" onkeydown=\"if(event.key==='Enter')document.getElementById('pw-btn').click()\"><br><button id=\"pw-btn\" onclick=\"decryptExport()\" style=\"margin-top:12px;background:#5865f2;color:#fff;border:none;border-radius:4px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit\">Unlock</button><div id=\"pw-error\" style=\"color:#ed4245;font-size:13px;margin-top:8px;display:none\">Wrong password</div></div></div>";
        // Hide overlay if already unlocked, show if not
        const overlayScript = "<script>if(window.__DCEF_UNLOCKED){var o=document.getElementById('pw-overlay');if(o)o.remove();}else{var i=document.getElementById('pw-input');if(i)i.focus();}</script>";
        html = html.replace("</body>", () => overlay + overlayScript + "</body>");
    }

    // Admin mode: inject editing capabilities
    if (adminMode) {
        const cleanName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
        const ts = Math.floor(Date.now() / 1000);
        const first3 = cleanName.slice(0, 3) || "exp";
        const last3 = cleanName.length > 3 ? cleanName.slice(-3) : first3;
        const normalFilename = `${first3}-${last3}-${ts}.html`;

        // Store the clean DCEF template (before any data/admin injection) so Finish Editing can rebuild cleanly
        const templateB64 = btoa(unescape(encodeURIComponent(template)));
        const templateScript = `<script>window.__DCEF_CLEAN_TEMPLATE=decodeURIComponent(escape(atob("${templateB64}")));</script>`;

        const adminScript = getAdminScript(normalFilename);
        html = html.replace("</body>", () => templateScript + adminScript + "</body>");
    }

    return html;
}

function getAdminScript(originalFilename?: string): string {
    const cleanFilename = originalFilename || "export";
    return `
<script>window.__DCEF_ADMIN_MODE=true;</script>
<div id="admin-toolbar" style="position:fixed;bottom:20px;right:20px;z-index:9998;display:flex;gap:8px;font-family:gg sans,Noto Sans,sans-serif">
<button onclick="adminAddMessage()" style="background:#5865f2;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.4)">+ Add Message</button>
<button onclick="adminImportMessage()" style="background:#3f4147;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.4)">📥 Import</button>
<button onclick="adminFinish()" style="background:#57f287;color:#000;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.4)">✓ Finish Editing</button>
</div>

<div id="admin-import-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:9999;font-family:gg sans,Noto Sans,sans-serif;overflow-y:auto">
<div style="max-width:640px;margin:60px auto;background:#2b2d31;border-radius:8px;padding:20px;color:#dbdee1">
<h3 style="margin:0 0 8px;color:#f2f3f5">Import Message</h3>
<div style="font-size:12px;color:#949ba4;margin-bottom:12px">Paste a raw Discord message object (from DevTools) <strong>or</strong> a DCEF message object. The channel, time, mentions and formatting are read from the JSON.</div>
<textarea id="admin-import-json" rows="14" placeholder='{ "id": "...", "content": "...", "author": {...}, "channel_id": "...", "timestamp": "...", ... }' spellcheck="false" style="width:100%;background:#1e1f22;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:8px;font-size:12px;margin-bottom:8px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;box-sizing:border-box"></textarea>
<div id="admin-import-error" style="color:#ed4245;font-size:13px;min-height:18px;margin-bottom:8px"></div>
<div style="display:flex;gap:8px;justify-content:flex-end">
<button onclick="closeImportModal()" style="background:#4e5058;color:#dbdee1;border:none;border-radius:4px;padding:8px 16px;font-size:14px;cursor:pointer">Cancel</button>
<button onclick="adminDoImport()" style="background:#5865f2;color:#fff;border:none;border-radius:4px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">Import</button>
</div>
</div>
</div>

<div id="admin-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:9999;font-family:gg sans,Noto Sans,sans-serif;overflow-y:auto">
<div style="max-width:500px;margin:60px auto;background:#2b2d31;border-radius:8px;padding:20px;color:#dbdee1">
<h3 id="admin-modal-title" style="margin:0 0 16px;color:#f2f3f5">Add Message</h3>

<label style="font-size:12px;font-weight:700;color:#b5bac1;text-transform:uppercase;display:block;margin-bottom:4px">Author</label>
<select id="admin-author" style="width:100%;background:#1e1f22;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:8px;font-size:14px;margin-bottom:12px" onchange="if(this.value==='__new__')document.getElementById('admin-newuser').style.display='block';else document.getElementById('admin-newuser').style.display='none'">
</select>
<div id="admin-newuser" style="display:none;margin-bottom:12px;padding:8px;background:#1e1f22;border-radius:4px">
<input id="admin-newname" type="text" placeholder="Display Name" style="width:100%;background:#313338;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:6px 8px;font-size:13px;margin-bottom:6px;box-sizing:border-box">
<input id="admin-newuname" type="text" placeholder="Username" style="width:100%;background:#313338;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:6px 8px;font-size:13px;margin-bottom:6px;box-sizing:border-box">
<input id="admin-newavatar" type="text" placeholder="Avatar URL (or paste base64)" style="width:100%;background:#313338;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:6px 8px;font-size:13px;box-sizing:border-box">
</div>

<label style="font-size:12px;font-weight:700;color:#b5bac1;text-transform:uppercase;display:block;margin-bottom:4px">Date & Time</label>
<input id="admin-datetime" type="datetime-local" style="width:100%;background:#1e1f22;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box;color-scheme:dark">

<label style="font-size:12px;font-weight:700;color:#b5bac1;text-transform:uppercase;display:block;margin-bottom:4px">Message Content</label>
<textarea id="admin-content" rows="5" placeholder="Type your message... (Discord markdown supported)" style="width:100%;background:#1e1f22;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:8px;font-size:14px;margin-bottom:8px;resize:vertical;font-family:inherit;box-sizing:border-box"></textarea>

<label style="font-size:12px;font-weight:700;color:#b5bac1;text-transform:uppercase;display:block;margin-bottom:4px">Image Attachment (optional)</label>
<input id="admin-img" type="text" placeholder="Image URL or paste base64 data URI" style="width:100%;background:#1e1f22;border:1px solid #3f4147;border-radius:4px;color:#dbdee1;padding:8px;font-size:14px;margin-bottom:4px;box-sizing:border-box">
<input id="admin-img-file" type="file" accept="image/*" onchange="adminImgFileChanged(this)" style="margin-bottom:16px;font-size:12px;color:#949ba4">

<div style="display:flex;gap:8px;justify-content:flex-end">
<button onclick="closeAdminModal()" style="background:#4e5058;color:#dbdee1;border:none;border-radius:4px;padding:8px 16px;font-size:14px;cursor:pointer">Cancel</button>
<button id="admin-save-btn" onclick="adminSave()" style="background:#5865f2;color:#fff;border:none;border-radius:4px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">Add Message</button>
</div>
</div>
</div>

<script>
var __adminState = JSON.parse(sessionStorage.getItem('__adminState_'+window.__DCEF_EXPORT_ID)||'null');
if(__adminState){window.__DCEF_DATA=__adminState.data;if(__adminState.highlightedIds)window.__DCEF_HIGHLIGHTED_IDS=__adminState.highlightedIds;}
var __editingMsgId=null;
var __insertRef=null;
var __insertDir='after';

function getAuthors(){
  var authors={};
  var d=window.__DCEF_DATA;
  if(!d||!d.messages)return[];
  d.messages.forEach(function(m){if(m.author&&!authors[m.author._id]){authors[m.author._id]=m.author;}});
  return Object.values(authors);
}

function populateAuthors(selectedId){
  var sel=document.getElementById('admin-author');
  sel.innerHTML='';
  var authors=getAuthors();
  authors.forEach(function(a){
    var o=document.createElement('option');
    o.value=a._id;
    o.textContent=a.nickname||a.name;
    if(selectedId&&a._id===selectedId)o.selected=true;
    sel.appendChild(o);
  });
  var newOpt=document.createElement('option');
  newOpt.value='__new__';
  newOpt.textContent='+ New User';
  sel.appendChild(newOpt);
}

function toLocalDatetime(d){
  // Convert Date to local datetime-local input value (YYYY-MM-DDTHH:MM)
  var y=d.getFullYear();
  var mo=String(d.getMonth()+1).padStart(2,'0');
  var da=String(d.getDate()).padStart(2,'0');
  var h=String(d.getHours()).padStart(2,'0');
  var mi=String(d.getMinutes()).padStart(2,'0');
  return y+'-'+mo+'-'+da+'T'+h+':'+mi;
}

function genSnowflake(ts){
  var epoch=1420070400000;
  var ms=ts.getTime()-epoch;
  var sf=(BigInt(ms)<<22n)|BigInt(Math.floor(Math.random()*4194304));
  return sf.toString().padStart(24,'0');
}

function makeAsset(url){
  return{_id:url||'0',originalPath:url||'',localPath:url||'',remotePath:url||'',path:url||'',extension:'',type:'image',width:0,height:0,sizeBytes:0,filenameWithHash:'',filenameWithoutHash:'',colorDominant:null,colorPalette:null};
}

function adminAddMessage(){
  __editingMsgId=null;
  __insertRef=null;
  __insertDir='bottom';
  document.getElementById('admin-modal-title').textContent='Add Message';
  document.getElementById('admin-save-btn').textContent='Add Message';
  populateAuthors();
  var now=new Date();
  document.getElementById('admin-datetime').value=toLocalDatetime(now);
  document.getElementById('admin-content').value='';
  document.getElementById('admin-img').value='';
  document.getElementById('admin-newuser').style.display='none';
  document.getElementById('admin-modal').style.display='block';
}

window.__adminAddMessageAfter=function(msg){
  __editingMsgId=null;
  __insertRef=msg._id;
  __insertDir='after';
  document.getElementById('admin-modal-title').textContent='Add Message After';
  document.getElementById('admin-save-btn').textContent='Add Message';
  populateAuthors(msg.author?._id);
  document.getElementById('admin-datetime').value=toLocalDatetime(new Date(msg.timestamp));
  document.getElementById('admin-content').value='';
  document.getElementById('admin-newuser').style.display='none';
  document.getElementById('admin-modal').style.display='block';
};

window.__adminAddMessageBefore=function(msg){
  __editingMsgId=null;
  __insertRef=msg._id;
  __insertDir='before';
  document.getElementById('admin-modal-title').textContent='Add Message Before';
  document.getElementById('admin-save-btn').textContent='Add Message';
  populateAuthors(msg.author?._id);
  document.getElementById('admin-datetime').value=toLocalDatetime(new Date(msg.timestamp));
  document.getElementById('admin-content').value='';
  document.getElementById('admin-newuser').style.display='none';
  document.getElementById('admin-modal').style.display='block';
};

window.__adminToggleHighlight=function(msg){
  var d=window.__DCEF_DATA;
  var m=d.messages.find(function(x){return x._id===msg._id;});
  if(m){m._highlighted=!m._highlighted;}
  saveAndReload();
};

window.__adminToggleDeleted=function(msg){
  var d=window.__DCEF_DATA;
  var m=d.messages.find(function(x){return x._id===msg._id;});
  if(m){m._deleted=!m._deleted;}
  saveAndReload();
};

window.__adminEditMessage=function(msg){
  __editingMsgId=msg._id;
  document.getElementById('admin-modal-title').textContent='Edit Message';
  document.getElementById('admin-save-btn').textContent='Save Changes';
  populateAuthors(msg.author?._id);
  document.getElementById('admin-datetime').value=toLocalDatetime(new Date(msg.timestamp));
  document.getElementById('admin-content').value=msg.content?.[0]?.content||'';
  // Pre-fill image if message has an image attachment
  var existingImg=msg.attachments&&msg.attachments.find(function(a){return a.type==='image';});
  document.getElementById('admin-img').value=existingImg?existingImg.path:'';
  document.getElementById('admin-newuser').style.display='none';
  document.getElementById('admin-modal').style.display='block';
};

window.__adminDeleteMessage=function(msg){
  if(!confirm('Delete this message?'))return;
  var d=window.__DCEF_DATA;
  d.messages=d.messages.filter(function(m){return m._id!==msg._id;});
  saveAndReload();
};

function closeAdminModal(){document.getElementById('admin-modal').style.display='none';}

function adminSave(){
  var d=window.__DCEF_DATA;
  var selVal=document.getElementById('admin-author').value;
  var author;
  if(selVal==='__new__'){
    var name=document.getElementById('admin-newname').value||'User';
    var uname=document.getElementById('admin-newuname').value||name.toLowerCase();
    var avUrl=document.getElementById('admin-newavatar').value||'https://cdn.discordapp.com/embed/avatars/0.png';
    author={_id:genSnowflake(new Date()),name:uname,nickname:name,color:'',isBot:false,avatar:makeAsset(avUrl),roles:[]};
  }else{
    author=getAuthors().find(function(a){return a._id===selVal;});
    if(!author)author={_id:'0',name:'Unknown',nickname:'Unknown',color:'',isBot:false,avatar:makeAsset(''),roles:[]};
  }

  var ts=new Date(document.getElementById('admin-datetime').value);
  var content=document.getElementById('admin-content').value;

  // Resolve target channel: source message (after/before insert) > URL hash (currently viewed) > first channel
  var chId=null,chName='',gId=null;
  if(__insertRef){
    var refMsg=d.messages.find(function(m){return m._id===__insertRef;});
    if(refMsg){chId=refMsg.channelId;gId=refMsg.guildId;chName=refMsg.channelName||'';}
  }
  if(!chId){
    try{
      var hash=(location.hash||'').replace(/^#/,'');
      var sp=new URLSearchParams(hash);
      var urlCh=sp.get('channel');
      if(urlCh&&d.channels){
        var match=d.channels.find(function(c){return c._id===urlCh;});
        if(match){chId=match._id;chName=match.name;gId=match.guildId;}
      }
    }catch(e){}
  }
  if(!chId){
    chId=d.channels&&d.channels[0]?d.channels[0]._id:'0';
    chName=d.channels&&d.channels[0]?d.channels[0].name:'';
    gId=d.channels&&d.channels[0]?d.channels[0].guildId:(d.guild?d.guild._id:'0');
  }

  if(__editingMsgId){
    var msg=d.messages.find(function(m){return m._id===__editingMsgId;});
    if(msg){
      msg.author=JSON.parse(JSON.stringify(author));
      msg.content=[{timestamp:msg.timestamp,content:content}];
      var editImgUrl=(document.getElementById('admin-img').value||'').trim();
      if(editImgUrl){
        msg.attachments=[makeAsset(editImgUrl)];
        msg.attachments[0].type='image';
        msg.attachments[0].filenameWithoutHash='image.png';
      }else{
        msg.attachments=null;
      }
    }
  }else{
    // Handle image attachment
    var imgUrl=(document.getElementById('admin-img').value||'').trim();
    var attachments=null;
    if(imgUrl){
      attachments=[makeAsset(imgUrl)];
      attachments[0].type='image';
      attachments[0].filenameWithoutHash='image.png';
      attachments[0].filenameWithHash='image.png';
      attachments[0].extension='png';
    }

    // Auto-detect embeds from URLs in content
    var embeds=null;
    var urlMatch=content.match(/https?:\\/\\/[^\\s]+/g);
    if(urlMatch){
      embeds=urlMatch.map(function(u){
        return{title:u.split('/').pop()||'Link',url:u,timestamp:null,description:'',
          thumbnail:null,images:[],video:null,fields:[],color:undefined,author:undefined,footer:undefined};
      });
    }

    var newMsg={
      _id:genSnowflake(ts),
      type:'Default',
      timestamp:ts.toISOString(),
      timestampEdited:null,
      callEndedTimestamp:null,
      isPinned:false,
      content:[{timestamp:ts.toISOString(),content:content}],
      author:JSON.parse(JSON.stringify(author)),
      stickers:null,reactions:null,emotes:null,mentions:null,
      attachments:attachments,embeds:embeds,reference:null,
      roles:[],channels:[],
      guildId:gId,channelId:chId,channelName:chName
    };

    if(__insertRef){
      var idx=d.messages.findIndex(function(m){return m._id===__insertRef;});
      if(idx!==-1){
        if(__insertDir==='after')d.messages.splice(idx+1,0,newMsg);
        else d.messages.splice(idx,0,newMsg);
      }else{
        d.messages.push(newMsg);
      }
    }else{
      // Sort by snowflake
      var inserted=false;
      for(var i=0;i<d.messages.length;i++){
        if(BigInt(d.messages[i]._id)>BigInt(newMsg._id)){
          d.messages.splice(i,0,newMsg);
          inserted=true;
          break;
        }
      }
      if(!inserted)d.messages.push(newMsg);
    }
  }

  saveAndReload();
}

function saveAndReload(){
  try{
    sessionStorage.setItem('__adminState_'+window.__DCEF_EXPORT_ID,JSON.stringify({data:window.__DCEF_DATA,highlightedIds:window.__DCEF_HIGHLIGHTED_IDS||[]}));
  }catch(e){
    alert('This export is too big for the browser session storage, so the page cannot reload to show this change. The change is kept in memory and is included when you click Finish Editing.');
    return;
  }
  location.reload();
}

function __safeJson(v){return JSON.stringify(v).replace(/</g,'\\\\u003c').replace(/\\u2028/g,'\\\\u2028').replace(/\\u2029/g,'\\\\u2029');}
function __escHtml(t){return String(t).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

function adminImgFileChanged(input){
  if(!input.files||!input.files[0])return;
  var reader=new FileReader();
  reader.onload=function(e){document.getElementById('admin-img').value=e.target.result;};
  reader.readAsDataURL(input.files[0]);
}

// ===== Import Message =====
function adminImportMessage(){
  document.getElementById('admin-import-json').value='';
  document.getElementById('admin-import-error').textContent='';
  document.getElementById('admin-import-modal').style.display='block';
  setTimeout(function(){document.getElementById('admin-import-json').focus();},50);
}
function closeImportModal(){document.getElementById('admin-import-modal').style.display='none';}

function pad24(id){return String(id||'0').padStart(24,'0');}
function httpUrl(u){return typeof u==='string'&&/^https?:[/][/]/i.test(u)?u:'';}

function makeImgAsset(url,w,h){
  return{_id:url||'0',originalPath:url||'',localPath:url||'',remotePath:url||'',path:url||'',extension:(String(url||'').split('.').pop()||'').split(/[?#]/)[0],type:'image',width:w||0,height:h||0,sizeBytes:0,filenameWithHash:'',filenameWithoutHash:'',colorDominant:null,colorPalette:null};
}

function buildAvatarUrl(uid,hash){
  if(hash)return'https://cdn.discordapp.com/avatars/'+uid+'/'+hash+(String(hash).startsWith('a_')?'.gif':'.webp')+'?size=128';
  try{var idx=Number(BigInt(uid)>>22n)%6;return'https://cdn.discordapp.com/embed/avatars/'+idx+'.png';}catch(e){return'https://cdn.discordapp.com/embed/avatars/0.png';}
}

function lookupAuthor(uid){
  var pid=pad24(uid);
  var d=window.__DCEF_DATA;
  if(!d||!d.messages)return null;
  for(var i=0;i<d.messages.length;i++){
    var a=d.messages[i].author;
    if(a&&a._id===pid)return a;
  }
  return null;
}

function convertRawToDcef(raw){
  var content=raw.content||'';
  var ts=raw.timestamp||new Date().toISOString();

  // Mentions: array of strings (user IDs) or full user objects
  var mentionsArr=raw.mentions||[];
  var mentions=mentionsArr.map(function(m){
    if(typeof m==='string'){
      var existing=lookupAuthor(m);
      if(existing)return{_id:existing._id,name:existing.name,discriminator:'0',nickname:existing.nickname,isBot:!!existing.isBot};
      return{_id:pad24(m),name:'user',discriminator:'0',nickname:'user',isBot:false};
    }
    return{_id:pad24(m.id),name:m.username||'user',discriminator:m.discriminator||'0',nickname:m.global_name||m.globalName||m.username||'Unknown',isBot:!!m.bot};
  });

  // Custom emojis from content
  var emotes=[];
  var seenEmotes={};
  var emRe=/<(a?):(\\w+):(\\d+)>/g, em;
  while((em=emRe.exec(content))!==null){
    if(seenEmotes[em[3]])continue;
    seenEmotes[em[3]]=true;
    emotes.push({_id:pad24(em[3]),name:em[2],isAnimated:!!em[1],image:makeImgAsset('https://cdn.discordapp.com/emojis/'+em[3]+'.'+(em[1]?'gif':'webp')+'?size=48',48,48),source:'custom',guildId:null});
  }

  // Attachments
  var attachments=(raw.attachments||[]).map(function(a){
    var ct=a.content_type||a.contentType||'';
    var t=ct.indexOf('image/')===0?'image':ct.indexOf('video/')===0?'video':ct.indexOf('audio/')===0?'audio':'unknown';
    var url=a.proxy_url||a.proxyUrl||a.url||'';
    var as=makeImgAsset(url,a.width||0,a.height||0);
    as.type=t;as.sizeBytes=a.size||0;
    as.filenameWithHash=a.filename||'file';as.filenameWithoutHash=a.filename||'file';
    as.extension=(a.filename||'').split('.').pop()||'';
    return as;
  });

  // Embeds
  var embeds=(raw.embeds||[]).map(function(e){
    var th=e.thumbnail?makeImgAsset(e.thumbnail.proxy_url||e.thumbnail.proxyUrl||e.thumbnail.url,e.thumbnail.width,e.thumbnail.height):null;
    var img=e.image?makeImgAsset(e.image.proxy_url||e.image.proxyUrl||e.image.url,e.image.width,e.image.height):null;
    var vid=e.video?makeImgAsset(e.video.proxy_url||e.video.proxyUrl||e.video.url,e.video.width,e.video.height):null;
    if(vid)vid.type='video';
    return{
      title:e.title||'',url:httpUrl(e.url),timestamp:e.timestamp||null,description:e.description||'',
      thumbnail:th,images:img?[img]:[],video:vid,
      fields:(e.fields||[]).map(function(f){return{name:f.name,value:f.value,isInline:!!f.inline};}),
      color:e.color?'#'+e.color.toString(16).padStart(6,'0'):undefined,
      author:e.author?{name:e.author.name||'',url:httpUrl(e.author.url),icon:(e.author.icon_url||e.author.iconUrl)?makeImgAsset(e.author.proxy_icon_url||e.author.proxyIconUrl||e.author.icon_url||e.author.iconUrl):undefined}:undefined,
      footer:e.footer?{text:e.footer.text||'',icon:(e.footer.icon_url||e.footer.iconUrl)?makeImgAsset(e.footer.proxy_icon_url||e.footer.proxyIconUrl||e.footer.icon_url||e.footer.iconUrl):undefined}:undefined
    };
  });

  // Stickers
  var stickerItems=raw.sticker_items||raw.stickerItems||[];
  var stickers=stickerItems.map(function(s){
    return{name:s.name,format:'Png',_id:pad24(s.id),source:makeImgAsset('https://media.discordapp.net/stickers/'+s.id+'.webp?size=160',160,160)};
  });

  // Reference (reply)
  var ref=raw.message_reference||raw.messageReference;
  var reference=ref?{messageId:pad24(ref.message_id||ref.messageId||''),channelId:pad24(ref.channel_id||ref.channelId||''),guildId:pad24(ref.guild_id||ref.guildId||''),message:null}:null;

  var author=raw.author||{};
  var avatarUrl=buildAvatarUrl(author.id||'0',author.avatar);

  return{
    _id:pad24(raw.id||genSnowflake(new Date(ts))),
    type:'Default',
    timestamp:ts,
    timestampEdited:raw.edited_timestamp||raw.editedTimestamp||null,
    callEndedTimestamp:null,
    isPinned:!!raw.pinned,
    content:[{timestamp:ts,content:content}],
    author:{
      _id:pad24(author.id||'0'),
      name:author.username||'user',
      nickname:author.global_name||author.globalName||author.username||'User',
      color:'',
      isBot:!!author.bot,
      avatar:makeImgAsset(avatarUrl,80,80),
      roles:[]
    },
    stickers:stickers.length?stickers:null,
    reactions:null,
    emotes:emotes.length?emotes:null,
    mentions:mentions.length?mentions:null,
    roles:[],channels:[],
    attachments:attachments.length?attachments:null,
    embeds:embeds.length?embeds:null,
    reference:reference,
    guildId:pad24(raw.guild_id||raw.guildId||'0'),
    channelId:pad24(raw.channel_id||raw.channelId||'0'),
    channelName:''
  };
}

// The same shape rules as an upload (exportUpload.ts hardenExportData), here for pasted JSON: no
// __proto__ / constructor / prototype keys (Finish Editing writes the data as an object literal, where
// "__proto__" sets the prototype), real arrays where DCEF has arrays (the viewer runs Array.from on
// anything else, so array-likes would iterate), plain objects where it has objects, stickers as plain
// images and http(s)-only links, quoted messages included.
var __SHAPE_LISTS={messages:1,channels:1,guilds:1,roles:1,images:1,fields:1,users:1,threads:1};
var __SHAPE_NULL_LISTS={stickers:1,reactions:1,emotes:1,mentions:1,attachments:1,embeds:1};
var __SHAPE_OBJECTS={guild:1,invites:1,author:1,reference:1,message:1,thumbnail:1,video:1,footer:1,icon:1,avatar:1,emoji:1,image:1};
function __own(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
function __plainObj(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
function __dcefShape(root){
  var st=[[root,false]];
  while(st.length){
    var it=st.pop(),o=it[0],sticker=it[1];
    if(Array.isArray(o)){o.forEach(function(v){if(v&&typeof v==='object')st.push([v,sticker]);});continue;}
    if(!__plainObj(o))continue;
    ['__proto__','constructor','prototype'].forEach(function(k){if(__own(o,k))delete o[k];});
    if(sticker){o.format='Png';if(o.source!=null&&!__plainObj(o.source))o.source=null;}
    Object.keys(o).forEach(function(k){
      var v=o[k];
      if(v==null)return;
      if(__own(__SHAPE_LISTS,k)&&!Array.isArray(v)){o[k]=[];return;}
      if(__own(__SHAPE_NULL_LISTS,k)&&!Array.isArray(v)){o[k]=null;return;}
      if(__own(__SHAPE_OBJECTS,k)&&!__plainObj(v)){o[k]=null;return;}
      if(k==='url'){o[k]=httpUrl(v);return;}
      if(typeof v==='object')st.push([v,k==='stickers']);
    });
  }
  return root;
}

function normalizeDcefMsg(m){
  __dcefShape(m);
  if(!m._id)m._id=genSnowflake(new Date(m.timestamp||Date.now()));
  if(typeof m.content==='string')m.content=[{timestamp:m.timestamp,content:m.content}];
  if(!Array.isArray(m.content))m.content=[{timestamp:m.timestamp,content:''}];
  if(!m.type)m.type='Default';
  if(!('timestampEdited' in m))m.timestampEdited=null;
  if(!('callEndedTimestamp' in m))m.callEndedTimestamp=null;
  if(!('isPinned' in m))m.isPinned=false;
  if(!__plainObj(m.author))m.author={_id:'0',name:'?',nickname:'?',color:'',isBot:false,avatar:makeImgAsset(''),roles:[]};
  // Drop the pasted channel list; the export's own channels are used
  m.channels=[];
  // Otherwise trusted as pasted: at least keep embed links http(s) and stickers plain images (no Lottie)
  if(Array.isArray(m.embeds))m.embeds.forEach(function(e){if(e){e.url=httpUrl(e.url);if(e.author)e.author.url=httpUrl(e.author.url);}});
  if(Array.isArray(m.stickers))m.stickers.forEach(function(s){if(s)s.format='Png';});
  return m;
}

function adminDoImport(){
  var d=window.__DCEF_DATA;
  var err=document.getElementById('admin-import-error');
  err.textContent='';
  var raw=document.getElementById('admin-import-json').value.trim();
  if(!raw){err.textContent='Paste a message object first.';return;}
  var obj;
  try{obj=JSON.parse(raw);}catch(e){err.textContent='Invalid JSON: '+e.message;return;}

  // Detect format: DCEF has _id and content as array
  var isDcef=obj&&obj._id&&Array.isArray(obj.content);
  var msg;
  try{msg=isDcef?normalizeDcefMsg(obj):__dcefShape(convertRawToDcef(obj));}
  catch(e){err.textContent="Couldn't read that message: "+e.message;return;}

  // Resolve channel: imported msg's channelId > URL hash > first channel
  var ch=null;
  if(msg.channelId&&d.channels){
    ch=d.channels.find(function(c){return c._id===msg.channelId;});
  }
  if(!ch){
    try{
      var urlCh=new URLSearchParams((location.hash||'').replace(/^#/,'')).get('channel');
      if(urlCh&&d.channels)ch=d.channels.find(function(c){return c._id===urlCh;});
    }catch(e){}
  }
  if(!ch)ch=d.channels&&d.channels[0];
  if(!ch){err.textContent='This export has no channel to import into.';return;}

  msg.channelId=ch._id;
  msg.channelName=ch.name;
  msg.guildId=ch.guildId;

  // Dedup
  if(d.messages.some(function(m){return m._id===msg._id;})){
    err.textContent='Message with ID '+msg._id+' already exists in this export.';
    return;
  }

  // Insert sorted by snowflake within the same channel; fall back to global order
  var inserted=false;
  for(var i=0;i<d.messages.length;i++){
    try{
      if(BigInt(d.messages[i]._id)>BigInt(msg._id)){
        d.messages.splice(i,0,msg);inserted=true;break;
      }
    }catch(e){}
  }
  if(!inserted)d.messages.push(msg);

  saveAndReload();
}

function adminFinish(){
  if(!confirm('Finish editing? This downloads a clean copy of the page without the editing buttons.'))return;

  // Use the stored clean template to rebuild HTML from scratch
  var tpl=window.__DCEF_CLEAN_TEMPLATE;
  if(!tpl){alert("Can't finish: the clean page template is missing from this file.");return;}

  // Collect highlighted and deleted message IDs for CSS (digits only: they go into CSS selectors)
  var hlIds=[];var delIds=[];
  window.__DCEF_DATA.messages.forEach(function(m){
    if(!/^[0-9]+$/.test(String(m._id)))return;
    if(m._highlighted)hlIds.push(m._id);
    if(m._deleted)delIds.push(m._id);
  });

  // Build data script with modified data
  var dataJs='window.__DCEF_DATA='+__safeJson(window.__DCEF_DATA)+';';
  if(hlIds.length>0)dataJs+='window.__DCEF_HIGHLIGHTED_IDS='+__safeJson(hlIds)+';';
  var dataTag='<scr'+'ipt>'+dataJs+'<'+'/script>';

  // Build highlight/deleted CSS
  var cssTag='';
  if(hlIds.length>0||delIds.length>0){
    var css='<st'+'yle>';
    if(hlIds.length)css+=hlIds.map(function(id){return'[data-id="'+id+'"]'}).join(',')+'{background:rgba(250,166,26,.12)!important;border-left:3px solid #faa61a!important}';
    if(delIds.length)css+=delIds.map(function(id){return'[data-id="'+id+'"]'}).join(',')+'{background:rgba(237,66,69,.1)!important;border-left:3px solid #ed4245!important}';
    css+='<'+'/style>';
    cssTag=css;
  }

  // Build patch script
  var patchJs="(function(){var op=history.pushState,or=history.replaceState;history.pushState=function(s,t,u){try{op.call(this,s,t,u)}catch(e){try{op.call(this,s,t)}catch(e2){}}};history.replaceState=function(s,t,u){try{or.call(this,s,t,u)}catch(e){try{or.call(this,s,t)}catch(e2){}}};var of=window.fetch;window.fetch=function(u,o){if(typeof u==='string'){if(u.startsWith('/api/'))return Promise.resolve(new Response('[]',{status:200}));if(u.includes('cdn.discordapp.com')||u.includes('media.discordapp.net')||u.includes('files.catbox.moe'))return of.apply(this,arguments).catch(function(){return new Response('',{status:200})})}return of.apply(this,arguments)};})();";
  var patchTag='<scr'+'ipt>'+patchJs+'<'+'/script>';

  var html=tpl;
  var insertPoint='<scr'+'ipt type="module"';
  if(html.indexOf(insertPoint)!==-1){
    html=html.replace(insertPoint,function(){return cssTag+patchTag+dataTag+insertPoint;});
  }
  html=html.replace('<title>DCE-Frontend</title>',function(){return '<title>'+__escHtml(document.title)+'</title>';});

  var blob=new Blob([html],{type:'text/html;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download='${cleanFilename}';a.click();
  URL.revokeObjectURL(url);
  sessionStorage.removeItem('__adminState_'+window.__DCEF_EXPORT_ID);
}
</script>`;
}
