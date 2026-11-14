/**
 * MNEMOS Browser · React Bits AnimatedList (adapted).
 *
 * Original: https://github.com/DavidHDev/react-bits
 * Original component: src/content/Components/AnimatedList/AnimatedList.jsx
 * License: MIT + Commons Clause, Copyright (c) 2026 David Haz.
 * Notice: ui/reactbits-license.txt
 *
 * Adaptation: keep the list's animated entry, keyboard/selection and scrolling
 * semantics while removing marketing gradients, icon packages, motion/react
 * and global shortcut handlers. React 18 UMD runs LOCALLY inside mnemos://app.
 * This is a read-only island; it never sends a message or invokes browser tools.
 */
(function () {
  'use strict';
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  if (!React || !ReactDOM || typeof ReactDOM.createRoot !== 'function') {
    window.MNEMOSReactBits = Object.freeze({ available: false });
    return;
  }
  const h = React.createElement;
  const roots = new Map();
  const seen = new Set();
  const expanded = new Set();
  const explicitlyClosed = new Set();
  let observer = null;

  function cleanDisconnected() {
    for (const [host, root] of roots) {
      if (!host.isConnected) {
        roots.delete(host);
        try { root.unmount(); } catch { /* stale root already removed */ }
      }
    }
  }
  function monitor() {
    if (observer || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(cleanDisconnected);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function AnimatedList({ items, renderItem }) {
    const ref = React.useRef(null);
    const entering = items.filter(item => !seen.has(item.id));
    React.useEffect(() => {
      for (const item of entering) seen.add(item.id);
    });
    function navigate(event) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...(ref.current?.querySelectorAll('button[data-rb-selectable]') ?? [])];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement);
      if (current < 0 && event.target !== ref.current) return;
      event.preventDefault();
      let next = current;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, Math.max(-1, current) + 1);
      if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
      buttons[next]?.focus();
    }
    return h('ol', {
      className: 'rb-animated-list',
      ref, onKeyDown: navigate,
      'aria-label': 'AI modeļu sarunas gājieni'
    }, items.map((item, index) => h('li', {
      key: item.id, className: 'rb-item' + (seen.has(item.id) ? '' : ' rb-enter'),
      style: { '--rb-delay': Math.min(index * 40, 180) + 'ms' }
    }, renderItem(item, index))));
  }
  function CouncilView({ council, statusLabel, errorLabel }) {
    const [, rerender] = React.useState(0);
    const items = Array.isArray(council?.turns) ? council.turns : [];
    const latestAnswered = items.reduce((result,item,index) => item.answer ? index : result, -1);
    return h('section', {
      className: 'rb-council',
      'aria-label': 'Dzīvā AI saruna',
      'data-reactbits-component': 'AnimatedList'
    }, h(AnimatedList, { items: items.map((t, index) => ({
      ...t,
      id: String(t.id || index + '-' + (t.model || 'model')),
      index
    })), renderItem: (item, index) => {
      const id = item.id;
      const active = ['AWAITING_RESPONSE', 'RECONCILING', 'INTENT_RECORDED'].includes(item.status);
      const done = item.status === 'CAPTURED';
      const hasAnswer = typeof item.answer === 'string' && item.answer.length > 0;
      const open = hasAnswer && (
        expanded.has(id) || (index === latestAnswered && !explicitlyClosed.has(id))
      );
      const routing = item.routing;
      const routingText = !routing ? '' :
        routing.status === 'THINKING' ? 'Koordinators izvēlas nākamo dalībnieku…' :
        routing.status === 'LOCAL_MODEL' ?
          'Nākamais: ' + routing.nextModel + ' · ' + routing.intent + ' · ' + routing.model :
          'Nākamais: ' + routing.nextModel + ' · rezerves secība';
      const top = h('div', { className: 'rb-turn-head' },
        h('span', { className: 'rb-turn-model' }, String(item.model ?? 'AI')),
        h('span', { className: 'rb-turn-status' }, statusLabel(item.status)),
        done ? h('span', { className: 'rb-turn-done', 'aria-label': 'Pabeigts' }, '✓') : null
      );
      const answerControl = hasAnswer ? h(React.Fragment, null,
        h('button', {
          type: 'button', className: 'rb-answer-toggle',
          'data-rb-selectable': '',
          'aria-expanded': open,
          'aria-controls': 'rb-answer-' + id,
          onClick() {
            if (open) { expanded.delete(id); explicitlyClosed.add(id); }
            else { expanded.add(id); explicitlyClosed.delete(id); }
            rerender(value => value + 1);
          }
        }, open ? 'Aizvērt atbildi' : 'Lasīt atbildi',
          h('span', { 'aria-hidden': true }, open ? ' −' : ' +')),
        h('div', {
          id: 'rb-answer-' + id,
          className: 'rb-answer-body', role: 'region', hidden: !open,
          'aria-label': String(item.model ?? 'AI') + ' atbilde'
        }, item.answer)
      ) : null;
      return h('article', {
        className: 'rb-turn' + (active ? ' rb-turn-active' : '') +
          (done ? ' rb-turn-complete' : '')
      },
      h('span', { className: 'rb-turn-number', 'aria-hidden': true },
        String(index + 1).padStart(2, '0')),
      h('div', { className: 'rb-turn-content' },
        top,
        routingText ? h('small', { className: 'rb-turn-meta' }, routingText) : null,
        item.inspectionAttempts > 0 && active ?
          h('small', { className: 'rb-turn-meta' },
            'Pārbaudes: ' + item.inspectionAttempts + ' · ' + (item.lastReadReason || 'GAIDA')) : null,
        item.url ? h('small', { className: 'rb-turn-url' }, String(item.url)) : null,
        answerControl,
        item.error ? h('p', { className: 'rb-turn-error' }, errorLabel(item.error)) : null
      ));
    }}));
  }

  // The visible model roster is a React Bits AnimatedList backed by the
  // original MNEMOS checkbox validation, not a second control system.
  function ModelRoster({items,onToggle,onReady}){
    const [selected,setSelected]=React.useState(
      ()=>new Set(items.filter(item=>item.selected).map(item=>item.id)));
    React.useEffect(()=>{onReady?.();},[]);
    return h('section',{className:'rb-roster',
      'data-reactbits-component':'AnimatedList',
      'aria-label':'Pieejamie AI modeļi'},
      h('div',{className:'rb-roster-heading'},
        h('span',null,'Savienotie modeļi'),
        h('span',{className:'rb-roster-version'},'REACT BITS · ACTIVE')),
      h(AnimatedList,{items,renderItem:(item,index)=>
        h('label',{className:'rb-roster-entry'},
          h('span',{className:'rb-roster-index','aria-hidden':true},
            String(index+1).padStart(2,'0')),
          h('span',{className:'rb-roster-info'},
            h('strong',null,item.model),h('small',null,item.title)),
          h('input',{type:'checkbox',checked:selected.has(item.id),
            'aria-label':'Iekļaut '+item.model+' sarunā',
            onChange:event=>{
              let allowed=selected.has(item.id);
              try{allowed=onToggle(item.id,event.target.checked)===true;}
              catch(error){console.error('MNEMOS roster toggle rejected:',String(error?.message||error));}
              setSelected(previous=>{
                const next=new Set(previous);
                if(allowed)next.add(item.id);else next.delete(item.id);
                return next;
              });
            }})
        )})
    );
  }
  window.MNEMOSReactBits = Object.freeze({
    available: true,
    component: 'React Bits / AnimatedList (adapted JS-CSS)',

    mountRoster(host,items,{onToggle,onReady}={}){
      if(!(host instanceof HTMLElement)||!host.isConnected||!Array.isArray(items)||
         typeof onToggle!=='function'||!items.every(item=>
           item&&typeof item.id==='string'&&
           typeof item.model==='string'&&typeof item.title==='string'))return false;
      try{
        let root=roots.get(host);
        if(!root){root=ReactDOM.createRoot(host);roots.set(host,root);}
        root.render(h(ModelRoster,{items,onToggle,onReady}));
        monitor();return true;
      }catch(error){
        const root=roots.get(host);roots.delete(host);
        try{root?.unmount();}catch{}
        console.error('MNEMOS React Bits roster failed:',String(error?.message||error));
        return false;
      }
    },
    mountCouncil(host, council, labels) {
      if (!(host instanceof HTMLElement) || !host.isConnected) return false;
      if (!council || !Array.isArray(council.turns)) return false;
      try {
        let root = roots.get(host);
        if (!root) {
          root = ReactDOM.createRoot(host);
          roots.set(host, root);
        }
        root.render(h(CouncilView, {
          council,
          statusLabel: typeof labels?.statusLabel === 'function' ? labels.statusLabel : value => String(value),
          errorLabel: typeof labels?.errorLabel === 'function' ? labels.errorLabel : value => String(value)
        }));
        monitor();
        return true;
      } catch (error) {
        const root = roots.get(host);
        roots.delete(host);
        try { root?.unmount(); } catch {}
        console.error('MNEMOS React Bits island mount failed:', String(error?.message || error));
        return false;
      }
    },
    dispose(host) {
      const root = roots.get(host);
      if (!root) return;
      roots.delete(host);
      root.unmount();
    },
    cleanup: cleanDisconnected
  });
})();
