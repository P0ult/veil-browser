'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** Bridge for the browser chrome (tab strip + toolbar). */
contextBridge.exposeInMainWorld('veil', {
  ready: () => ipcRenderer.send('chrome:ready'),
  reportLayout: (layout) => ipcRenderer.send('ui:layout', layout),
  setAppearance: (patch) => ipcRenderer.invoke('settings:set', { appearance: patch }),

  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  },

  tab: {
    open: (url) => ipcRenderer.send('tab:new', url),
    close: (id) => ipcRenderer.send('tab:close', id),
    select: (id) => ipcRenderer.send('tab:select', id),
    move: (id, index) => ipcRenderer.send('tab:move', id, index)
  },

  nav: {
    back: () => ipcRenderer.send('nav:back'),
    forward: () => ipcRenderer.send('nav:forward'),
    reload: (bypass) => ipcRenderer.send('nav:reload', !!bypass),
    stop: () => ipcRenderer.send('nav:stop'),
    home: () => ipcRenderer.send('nav:home'),
    go: (text) => ipcRenderer.send('nav:go', text),
    goNewTab: (text) => ipcRenderer.send('nav:newtab', text)
  },

  find: {
    run: (text, opts) => ipcRenderer.send('find:run', text, opts),
    stop: () => ipcRenderer.send('find:stop')
  },

  menu: () => ipcRenderer.send('menu:main'),
  shield: () => ipcRenderer.send('shield:toggle'),
  action: (name, arg) => ipcRenderer.send('action', name, arg),

  vpn: {
    status: () => ipcRenderer.invoke('vpn:status'),
    launch: () => ipcRenderer.invoke('vpn:launch'),
    logs: () => ipcRenderer.send('vpn:logs')
  },

  tunnel: {
    status: () => ipcRenderer.invoke('tunnel:status'),
    toggle: () => ipcRenderer.invoke('tunnel:toggle'),
    reconnect: () => ipcRenderer.invoke('tunnel:reconnect')
  },

  answerPrompt: (id, choice) => ipcRenderer.send('prompt:answer', id, choice),

  getSettings: () => ipcRenderer.invoke('settings:get'),

  on: (event, cb) => {
    const channels = {
      tabs: 'veil:tabs',
      settings: 'veil:settings',
      vpn: 'veil:vpn',
      tunnel: 'veil:tunnel',
      prompt: 'veil:prompt',
      promptClose: 'veil:prompt-close',
      window: 'veil:window',
      toast: 'veil:toast',
      findResult: 'veil:find-result',
      focusOmnibox: 'veil:focus-omnibox',
      openFind: 'veil:open-find',
      findNext: 'veil:find-next',
      chromeHover: 'veil:chrome-hover'
    };
    const channel = channels[event];
    if (!channel) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
