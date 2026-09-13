'use strict';
const { Menu, MenuItem, clipboard, shell, webContents: WC } = require('electron');

/**
 * Menus. The window is frameless so the menu bar is never drawn, but keeping a
 * real application menu is what gives every standard editing and navigation
 * accelerator (copy, paste, select-all, Ctrl+T, Alt+Left) its normal behaviour.
 */

function buildAppMenu(ctx) {
  const { tabs, actions } = ctx;
  const focused = () => WC.getFocusedWebContents();

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => actions.newTab() },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => actions.closeTab() },
        { label: 'Reopen closed tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => tabs.reopenClosed() },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => actions.openInternal('veil://settings/') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => actions.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle', accelerator: 'CmdOrCtrl+Shift+V' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in page', accelerator: 'CmdOrCtrl+F', click: () => actions.openFind() },
        { label: 'Find next', accelerator: 'F3', click: () => actions.findNext(true) },
        { label: 'Find previous', accelerator: 'Shift+F3', click: () => actions.findNext(false) },
        { type: 'separator' },
        { label: 'Copy current address', accelerator: 'CmdOrCtrl+Shift+C', click: () => actions.copyAddress() }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => actions.reload(false) },
        { label: 'Reload (bypass cache)', accelerator: 'CmdOrCtrl+Shift+R', click: () => actions.reload(true) },
        { label: 'Reload', accelerator: 'F5', visible: false, click: () => actions.reload(false) },
        { label: 'Stop', click: () => actions.stop() },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => actions.zoom(+1) },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => actions.zoom(+1) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => actions.zoom(-1) },
        { label: 'Reset zoom', accelerator: 'CmdOrCtrl+0', click: () => actions.zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => actions.devtools() }
      ]
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => actions.back() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => actions.forward() },
        { label: 'Home', accelerator: 'Alt+Home', click: () => actions.home() },
        { type: 'separator' },
        { label: 'Focus address bar', accelerator: 'CmdOrCtrl+L', click: () => actions.focusOmnibox() },
        { label: 'Focus address bar', accelerator: 'F6', visible: false, click: () => actions.focusOmnibox() },
        { label: 'Focus address bar', accelerator: 'Alt+D', visible: false, click: () => actions.focusOmnibox() },
        { type: 'separator' },
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: () => tabs.cycle(+1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: () => tabs.cycle(-1) },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
          label: 'Tab ' + n, accelerator: 'CmdOrCtrl+' + n, visible: false,
          click: () => { const id = tabs.order[n - 1]; if (id != null) tabs.select(id); }
        })),
        {
          label: 'Last tab', accelerator: 'CmdOrCtrl+9', visible: false,
          click: () => { const id = tabs.order[tabs.order.length - 1]; if (id != null) tabs.select(id); }
        }
      ]
    },
    {
      label: 'Privacy',
      submenu: [
        { label: 'Turn the tunnel on or off', click: () => actions.tunnelToggle() },
        { label: 'Passwords', accelerator: 'CmdOrCtrl+Shift+P', click: () => actions.passwords() },
        { type: 'separator' },
        { label: 'Pause blocking on this site', click: () => actions.toggleSiteBlocking() },
        { label: 'Update blocklists…', click: () => actions.updateLists() },
        { label: 'Clear everything now', click: () => actions.clearData() },
        { type: 'separator' },
        {
          label: 'System VPN',
          submenu: [
            { label: 'Open Tunnel VPN', click: () => actions.vpnLaunch() },
            { label: 'Logs folder', click: () => actions.vpnLogs() }
          ]
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Veil', click: () => actions.openInternal('veil://about/') }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

/** Right-click menu inside a page. */
function pageContextMenu(ctx, tab, params) {
  const { actions, settings } = ctx;
  const wc = tab.view.webContents;
  const menu = new Menu();
  const add = o => menu.append(new MenuItem(o));
  let need = false;

  if (params.linkURL) {
    add({ label: 'Open link in new tab', click: () => actions.newTab(params.linkURL, true) });
    add({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    add({ label: 'Open link in system browser', click: () => shell.openExternal(params.linkURL).catch(() => {}) });
    need = true;
  }

  if (params.mediaType === 'image' && params.srcURL) {
    if (need) add({ type: 'separator' });
    add({ label: 'Open image in new tab', click: () => actions.newTab(params.srcURL, true) });
    add({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    add({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
    add({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) });
    need = true;
  }

  if (params.isEditable) {
    if (need) add({ type: 'separator' });
    add({ role: 'undo' });
    add({ role: 'redo' });
    add({ type: 'separator' });
    add({ role: 'cut', enabled: !!params.selectionText });
    add({ role: 'copy', enabled: !!params.selectionText });
    add({ role: 'paste' });
    add({ label: 'Paste as plain text',
          click: async () => wc.insertText(String(await clipboard.readText() || '')) });
    add({ role: 'selectAll' });
    need = true;
  } else if (params.selectionText) {
    if (need) add({ type: 'separator' });
    add({ role: 'copy' });
    const q = params.selectionText.trim().slice(0, 60);
    add({ label: 'Search Veil for "' + q + '"', click: () => actions.searchFor(params.selectionText.trim(), true) });
    if (/^https?:\/\/\S+$/i.test(params.selectionText.trim())) {
      add({ label: 'Open selected address', click: () => actions.newTab(params.selectionText.trim(), true) });
    }
    need = true;
  }

  if (need) add({ type: 'separator' });
  add({ label: 'Back', enabled: tab.canGoBack, click: () => actions.back() });
  add({ label: 'Forward', enabled: tab.canGoForward, click: () => actions.forward() });
  add({ label: 'Reload', click: () => actions.reload(false) });
  add({ type: 'separator' });
  add({ label: 'Copy page address', click: () => clipboard.writeText(tab.url) });
  add({ label: 'Select all', role: 'selectAll' });
  add({ type: 'separator' });
  add({ label: 'Inspect element', click: () => { wc.inspectElement(params.x, params.y); } });

  return menu;
}


/**
 * Right-clicking the address bar.
 *
 * The chrome is a web page, so without this it gets Chromium's nothing at all:
 * a right-click in the address bar did not even offer Paste. The two entries
 * worth having that a plain text field does not give you are "Paste and go",
 * which is the reason most people right-click an address bar in the first
 * place, and "Copy the current address", which is what they meant when the bar
 * was not focused.
 */
function omniboxContextMenu(ctx, params) {
  const { actions, chromeContents, currentUrl } = ctx;
  const menu = new Menu();
  const add = o => menu.append(new MenuItem(o));
  const flags = params.editFlags || {};
  // Handed in already read: the clipboard is asynchronous from Electron 44,
  // and whether Paste is live has to be known while the menu is being built.
  const pasteable = String(ctx.clipboardText || '').trim();

  add({ role: 'undo', enabled: flags.canUndo !== false });
  add({ role: 'redo', enabled: flags.canRedo !== false });
  add({ type: 'separator' });
  add({ role: 'cut', enabled: !!params.selectionText });
  add({ role: 'copy', enabled: !!params.selectionText });
  add({ role: 'paste', enabled: !!pasteable });

  add({
    label: 'Paste and go',
    enabled: !!pasteable,
    click: () => actions.go(pasteable)
  });

  add({ type: 'separator' });
  add({
    label: 'Copy the current address',
    enabled: !!currentUrl,
    click: () => clipboard.writeText(currentUrl)
  });
  add({
    label: 'Select all',
    enabled: flags.canSelectAll !== false,
    click: () => { if (chromeContents) chromeContents.selectAll(); }
  });
  add({
    label: 'Delete',
    enabled: !!params.selectionText,
    click: () => { if (chromeContents) chromeContents.delete(); }
  });

  return menu;
}

/** The toolbar's ⋮ button. */
function mainMenu(ctx) {
  const { actions, adblock, tabs, settings } = ctx;
  const tab = tabs.active();
  let host = '';
  try { host = new URL(tab ? tab.url : '').hostname.replace(/^www\./, ''); } catch {}
  const paused = host ? adblock.isAllowedSite(host) : false;

  const template = [
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => actions.newTab() },
    { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', click: () => tabs.reopenClosed() },
    { type: 'separator' },
    { label: 'Find in page', accelerator: 'Ctrl+F', click: () => actions.openFind() },
    {
      label: 'Zoom',
      submenu: [
        { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => actions.zoom(+1) },
        { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => actions.zoom(-1) },
        { label: 'Reset', accelerator: 'Ctrl+0', click: () => actions.zoom(0) }
      ]
    },
    { type: 'separator' },
    {
      label: host ? (paused ? 'Resume blocking on ' + host : 'Pause blocking on ' + host) : 'Pause blocking on this site',
      enabled: !!host,
      click: () => actions.toggleSiteBlocking()
    },
    { label: 'Update blocklists…', click: () => actions.updateLists() },
    { label: 'Clear everything now', click: () => actions.clearData() },
    { type: 'separator' },
    { label: 'Passwords', accelerator: 'Ctrl+Shift+P', click: () => actions.passwords() },
    { label: 'Turn the tunnel on or off', click: () => actions.tunnelToggle() },
    { type: 'separator' },
    { label: 'Settings', accelerator: 'Ctrl+,', click: () => actions.openInternal('veil://settings/') },
    { label: 'About Veil', click: () => actions.openInternal('veil://about/') },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Ctrl+Q', click: () => actions.quit() }
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildAppMenu, pageContextMenu, omniboxContextMenu, mainMenu };
