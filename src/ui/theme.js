/* Applies the appearance settings to any Veil surface. Loaded by the chrome
   and by every internal page, so a change in Settings lands everywhere at once. */
(function () {
  'use strict';

  function ensureLayers() {
    if (!document.getElementById('veil-bg')) {
      const bg = document.createElement('div');
      bg.id = 'veil-bg';
      const dim = document.createElement('div');
      dim.id = 'veil-bg-dim';
      document.body.prepend(dim);
      document.body.prepend(bg);
    }
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  /** Pick black or white text for an accent-coloured button. */
  function readableInk(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#06120c';
    const [r, g, b] = rgb.map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.45 ? '#0a0f16' : '#ffffff';
  }

  function apply(settings) {
    if (!settings || !settings.appearance) return;
    const a = settings.appearance;
    const root = document.documentElement;

    // No light/dark setting: the background decides. Choose a pale colour and
    // the text, surfaces and borders swap to their light values so it stays
    // readable; choose a dark one and nothing changes.
    const chosen = a.bgColor || (a.bgType === 'gradient' && a.bgGradientA) || '';
    const isLight = chosen ? readableInk(chosen) === '#0a0f16' : false;
    root.setAttribute('data-theme', isLight ? 'light' : 'dark');
    root.setAttribute('data-font', a.font || 'system');
    root.setAttribute('data-density', a.density || 'comfortable');

    root.style.setProperty('--accent', a.accent || '#7dd3a0');
    root.style.setProperty('--accent-ink', readableInk(a.accent));
    root.style.setProperty('--radius', (a.radius == null ? 12 : a.radius) + 'px');

    // Blank means the theme's own blue; anything else is the user's choice.
    if (a.linkColor) {
      root.style.setProperty('--link', a.linkColor);
      root.style.setProperty('--link-visited', a.linkColor);
    } else {
      root.style.removeProperty('--link');
      root.style.removeProperty('--link-visited');
    }

    if (a.railColor) root.style.setProperty('--rail-bg', a.railColor);
    else root.style.removeProperty('--rail-bg');

    root.setAttribute('data-outline', a.outline === false ? '0' : '1');
    root.setAttribute('data-glass', a.glass ? '1' : '0');

    if (!document.body) return;
    ensureLayers();

    const bg = document.getElementById('veil-bg');
    const dim = document.getElementById('veil-bg-dim');
    // Every one of these falls back to the theme when it is blank, which is
    // what makes the light theme actually light.
    const light = isLight;
    const base = a.bgColor || (light ? '#f2f4f7' : '#0b0e13');
    const gradA = a.bgGradientA || base;
    const gradB = a.bgGradientB || (light ? '#e4e9f0' : '#131b26');
    root.style.setProperty('--bg', base);

    if (a.bgType === 'image' && a.bgImage) {
      const url = /^https?:/i.test(a.bgImage)
        ? a.bgImage
        : 'veil://asset/bg?v=' + encodeURIComponent(a.bgImage).slice(-64);
      bg.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      bg.style.backgroundColor = base;
      bg.style.backgroundSize = a.bgFit === 'tile' ? 'auto'
        : a.bgFit === 'contain' ? 'contain'
        : a.bgFit === 'center' ? 'auto' : 'cover';
      bg.style.backgroundRepeat = a.bgFit === 'tile' ? 'repeat' : 'no-repeat';
      bg.style.filter = a.bgBlur ? 'blur(' + a.bgBlur + 'px)' : '';
      bg.style.transform = a.bgBlur ? 'scale(1.04)' : '';
    } else if (a.bgType === 'gradient') {
      bg.style.backgroundImage =
        'linear-gradient(' + (a.bgGradientAngle || 160) + 'deg, ' + gradA + ', ' + gradB + ')';
      bg.style.filter = '';
      bg.style.transform = '';
    } else {
      bg.style.backgroundImage = 'none';
      bg.style.backgroundColor = base;
      bg.style.filter = '';
      bg.style.transform = '';
    }

    dim.style.opacity = a.bgType === 'image' ? String(Math.max(0, Math.min(1, a.bgDim ?? 0.45))) : '0';
  }

  window.VeilTheme = { apply, readableInk };
})();
