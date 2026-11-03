/**
 * P3-14 HTML previews: the srcdoc starts with the CSP meta, and the DOMParser strip removes every
 * active element and attribute before the HTML reaches the sandboxed iframe, again on its own
 * output until a parse finds nothing left (mutation XSS), else null and the file shows as text.
 * Behaviour (script never runs, remote loads blocked, links do not navigate) is checked in
 * e2e/p3-rich-preview.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildHtmlPreview, HTML_PREVIEW_CSP, stripActiveHtml } from '../src/lib/html-preview';

const META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

const HOSTILE = `<!doctype html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=https://evil.example/">
  <meta http-equiv="Content-Security-Policy" content="default-src *">
  <base href="https://evil.example/">
  <link rel="stylesheet" href="https://evil.example/x.css">
  <style>body { color: red; } @import url(https://evil.example/y.css);</style>
  <script>parent.document.title = 'owned'</script>
</head>
<body onload="alert(1)">
  <h1 onclick="alert(2)" class="title">Report</h1>
  <p>Hello <a href="https://evil.example/" target="_top" ping="https://evil.example/p">link</a></p>
  <img src="data:image/png;base64,AAAA" alt="inline" onerror="alert(3)">
  <iframe src="https://evil.example/"></iframe>
  <frameset><frame src="https://evil.example/"></frameset>
  <object data="https://evil.example/x.swf"></object>
  <embed src="https://evil.example/x.swf">
  <form action="https://evil.example/steal"><input name="q"><button formaction="https://evil.example/">Go</button></form>
  <button formaction="https://evil.example/f">Outside</button>
  <svg><script>alert(4)</script><a href="https://evil.example/"><text>svg link</text></a><animate attributeName="href" to="javascript:alert(5)"/><set attributeName="href" to="javascript:alert(6)"/></svg>
  <div ONMOUSEOVER="alert(7)" style="color: blue">styled</div>
</body>
</html>`;

describe('html preview srcdoc', () => {
  it('starts with the CSP meta exactly', () => {
    expect(HTML_PREVIEW_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    const srcdoc = buildHtmlPreview('<p>Hi</p>')!;
    expect(srcdoc.startsWith(META)).toBe(true);
    expect(srcdoc).toContain('<p>Hi</p>');
  });

  it('strips script, iframe, object, embed, base, user meta, link, form and on* attributes', () => {
    const srcdoc = buildHtmlPreview(HOSTILE)!;
    const body = srcdoc.slice(META.length).toLowerCase();
    for (const tag of [
      'script',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'base',
      'meta',
      'link',
      'form',
    ]) {
      expect(body).not.toContain(`<${tag}`);
    }
    expect(body).not.toContain('<animate');
    expect(body).not.toContain('<set');
    expect(body).not.toMatch(/\son[a-z]+=/);
    expect(body).not.toContain('alert(');
    expect(body).not.toContain('refresh');
    // exactly one meta: ours
    expect(srcdoc.match(/<meta/gi)).toHaveLength(1);
  });

  it('removes link targets so a click cannot navigate', () => {
    const body = buildHtmlPreview(HOSTILE)!.slice(META.length);
    expect(body).not.toMatch(/\shref=/i);
    expect(body).not.toMatch(/\starget=/i);
    expect(body).not.toMatch(/\sping=/i);
    expect(body).not.toMatch(/formaction=/i);
    expect(body).not.toContain('evil.example/"');
    expect(body).toContain('>link</a>');
    expect(body).toContain('svg link');
  });

  it('keeps the content: text, classes, inline styles and data: images', () => {
    const body = buildHtmlPreview(HOSTILE)!.slice(META.length);
    expect(body).toContain('<h1 class="title">Report</h1>');
    expect(body).toContain('<style>body { color: red; }');
    expect(body).toContain('style="color: blue"');
    expect(body).toContain('src="data:image/png;base64,AAAA"');
    expect(body).toContain('>Outside</button>');
  });

  it('stays clean when the frame parses the srcdoc again (mutation XSS)', () => {
    const payloads = [
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)><meta http-equiv=refresh content=0;url=/x>',
      '<svg></p><style><a id="</style><img src=1 onerror=alert(2)>">',
      '<math><mtext><h1><a><h6></a></h6><mglyph><svg><mtext><style><a title="</style><img src onerror=alert(3)>"></style></h1>',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(4)>',
    ];
    for (const payload of payloads) {
      const srcdoc = buildHtmlPreview(payload);
      if (srcdoc === null) continue; // not stable: shown as text, never in the frame
      // what the frame builds from the srcdoc
      const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
      expect(doc.querySelectorAll('meta')).toHaveLength(1);
      expect(doc.querySelector('meta')?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
      for (const element of doc.querySelectorAll('*')) {
        expect([...element.attributes].filter((a) => a.name.toLowerCase().startsWith('on'))).toEqual([]);
      }
      expect(doc.querySelector('script, iframe, form, base, link, object, embed')).toBeNull();
    }
  });

  it('keeps nested mutation payloads clean too (or shows them as text)', () => {
    // nested mutations: each re-parse can turn raw text into new markup again
    const nested = `${'<math><mtext><table><mglyph><style>'.repeat(4)}<img src=x onerror=alert(1)>`;
    const srcdoc = buildHtmlPreview(nested);
    if (srcdoc !== null) {
      const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
      expect(doc.querySelector('[onerror]')).toBeNull();
    }
  });

  it('treats a fragment and an empty document the same way', () => {
    expect(buildHtmlPreview('')).toBe(META);
    const doc = stripActiveHtml('<b onclick="x()">bold</b><script>1</script>');
    expect(doc).toBe('<b>bold</b>');
  });
});
