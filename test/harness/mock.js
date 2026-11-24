window.__sent=[];window.acquireVsCodeApi=()=>({postMessage(m){window.__sent.push(m);window.onSend&&window.onSend(m)},getState(){},setState(){}});
window.emit=(m)=>window.postMessage(m,'*');
