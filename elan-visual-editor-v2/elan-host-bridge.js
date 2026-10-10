/* Install in the existing Elan Scents app, not in the editor.
   Backend integration, permissions, layout persistence and rendering must be implemented by the host app. */
(function(){'use strict';
const protocol='elan-editor-bridge/v1';
const allowedActions=new Set(['page.getState','element.select','element.move','element.resize','element.format','element.setText','element.setMedia','element.create','element.duplicate','element.archive','archive.restore','library.open','ui.openCreatePanel','ui.openFormatPanel','ui.openMediaPanel','history.undo','history.redo','page.save','page.markSaved']);
window.ElanHostBridge={install(options){if(!Array.isArray(options.allowedEditorOrigins)||!options.allowedEditorOrigins.length||options.allowedEditorOrigins.some(x=>x==='*'))throw Error('Explicit editor origins required');if(typeof options.authorize!=='function'||typeof options.execute!=='function'||typeof options.getState!=='function')throw Error('authorize, execute and getState implementations required');let session=null;let processing=Promise.resolve();const origins=new Set(options.allowedEditorOrigins.map(x=>new URL(x).origin));
function send(type,payload){if(session)session.source.postMessage({protocol,type,session:session.id,...payload},session.origin);}
async function receive(e){const m=e.data;if(!m||m.protocol!==protocol||!origins.has(e.origin)||e.source!==window.parent||window.parent===window)return;
if(m.type==='hello'){if(typeof m.session!=='string'||m.session.length>120)return;session=null;try{const permitted=await options.authorize({origin:e.origin});if(permitted!==true)throw Error('Not authorized');const snapshot=await options.getState();if(!snapshot||snapshot.revision===undefined)throw Error('Missing published revision');session={id:m.session,origin:e.origin,source:e.source};send('ready',{authorized:true,page:snapshot});}catch(err){e.source.postMessage({protocol,type:'denied',session:m.session,message:'Admin authentication or page preparation is not available.'},e.origin);}return;}
if(!session||m.session!==session.id||e.source!==session.source||m.type!=='request'||typeof m.id!=='string')return;
if(!allowedActions.has(m.action)){send('response',{id:m.id,ok:false,error:'Unsupported action'});return;}
// Serialize edits/saves; authoritative permission checks still belong in every server operation.
processing=processing.then(async()=>{try{if(await options.authorize({origin:e.origin})!==true)throw Error('Authorization expired');const result=await options.execute(m.action,m.payload||{}, {expectedRevision:m.expectedRevision,requestId:m.id});if(m.action==='page.save'&&(result?.revision===undefined||result?.published!==true))throw Error('Save must confirm a committed published revision');send('response',{id:m.id,ok:true,result:result??null});}catch(err){send('response',{id:m.id,ok:false,error:err?.message||'Action failed'});}});
}
window.addEventListener('message',receive);
return {selection(element){send('selection',{element});},dirty(value){send('dirty',{dirty:!!value});},revision(revision){send('revision',{revision});},dispose(){window.removeEventListener('message',receive);session=null;}};
}};
})();
