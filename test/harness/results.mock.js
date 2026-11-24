window.onSend=(m)=>{if(m.type==='ready'){
emit({type:'init',mode:'results',title:'Production DB › shop',subtitle:'SELECT o.id, c.full_name, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 100',readOnly:false});
emit({type:'running',label:'Running query…',statementCount:2});
const cols=[{name:'id',type:'INT',numeric:true,pk:true},{name:'full_name',type:'VARCHAR'},{name:'total',type:'DECIMAL',numeric:true},{name:'created_at',type:'DATETIME'},{name:'note',type:'TEXT'}];
const rows=Array.from({length:5000},(_,i)=>[i+1,['Ali','Vali','Gani','Sami'][i%4]+' '+i,(i*3.75).toFixed(2),'2025-05-0'+(1+i%9)+' 10:00:00',i%3?null:'Long note text that goes on and on to show ellipsis behaviour in cells']);
setTimeout(()=>{emit({type:'result',result:{id:1,sql:'SELECT ...',kind:'rows',columns:cols,rows,totalRows:48211,truncated:true,durationMs:142}});
emit({type:'result',result:{id:2,sql:"UPDATE orders SET status='paid' WHERE id IN (1,2,3)",kind:'ok',columns:[],rows:[],totalRows:0,truncated:false,affectedRows:3,durationMs:8,info:'Rows matched: 3  Changed: 3  Warnings: 0'}});
emit({type:'done',cancelled:false,durationMs:150});},300);}};
