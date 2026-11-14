const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mnemos', Object.freeze({
  invoke: (operation, payload = {}) => ipcRenderer.invoke('mnemos:command', operation, payload),
  subscribe: callback => { const listener=(_event,state)=>callback(state);ipcRenderer.on('mnemos:state',listener);return()=>ipcRenderer.removeListener('mnemos:state',listener); },
  onFocusAddress: callback => {const listener=()=>callback();ipcRenderer.on('mnemos:focus-address',listener);return()=>ipcRenderer.removeListener('mnemos:focus-address',listener);}
}));
