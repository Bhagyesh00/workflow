/**
 * Form pages as plain functions. Every value goes through the `html` tag, which escapes it; only the
 * outputs of sanitize.ts and of `scriptJson` are marked safe. The script reads its settings from a
 * JSON block and writes with textContent only.
 */
import type { FormField } from './fields';
import { sanitizeCustomCss, sanitizeHtml } from './sanitize';

class SafeHtml {
  constructor(readonly value: string) {}
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]);

type HtmlValue = string | number | boolean | null | undefined | SafeHtml | HtmlValue[];

const write = (value: HtmlValue): string => {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(write).join('');
  return escapeHtml(String(value));
};

/** a template whose values are escaped, unless they are SafeHtml */
function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  return new SafeHtml(strings.reduce((out, text, i) => `${out}${write(values[i - 1])}${text}`));
}

/** JSON for a script element: nothing in it can end the element or a line of the script */
function scriptJson(value: unknown): SafeHtml {
  const text = JSON.stringify(value).replace(
    /[<\p{Zl}\p{Zp}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return new SafeHtml(text);
}

/** a field as the page shows it */
export interface FormPageField extends FormField {
  /** the prefilled or default value */
  value?: string;
  /** the prefilled or default choices of a Checkboxes field */
  values?: string[];
}

export interface FormPageData {
  title: string;
  /** sanitized here */
  description: string;
  fields: FormPageField[];
  buttonLabel: string;
  customCss?: string;
  testMode: boolean;
  attribution: boolean;
  /** sent as `x-auth-token` on submit */
  authToken?: string;
  /** what the page shows after a submit when the reply names nothing */
  submittedText: string;
  /** checked by the caller: http or https only */
  redirectUrl?: string;
}

const STYLES = `
*{box-sizing:border-box}
body{margin:0;padding:32px 16px;background:#f5f5f7;color:#1f1f24;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:0 auto}
.card{background:#fff;border:1px solid #e3e3e8;border-radius:10px;padding:24px}
h1{margin:0 0 8px;font-size:22px;line-height:1.3}
.description{margin:0 0 20px;color:#55555f}
.notice{margin:0 0 16px;padding:8px 12px;border-radius:6px;background:#fff6e0;color:#6b4e00;font-size:13px}
.field{margin:0 0 18px;padding:0;border:0;min-width:0}
.label{display:block;margin:0 0 6px;padding:0;font-weight:600}
.required::after{content:" *";color:#c02b2b}
input[type=text],input[type=email],input[type=number],input[type=password],input[type=date],input[type=file],select,textarea{
display:block;width:100%;padding:9px 11px;border:1px solid #c9c9d1;border-radius:6px;background:#fff;color:inherit;font:inherit}
textarea{min-height:96px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid #5b4fd6;outline-offset:1px}
.choice{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-weight:400}
.field-error{margin:6px 0 0;color:#c02b2b;font-size:13px}
button{display:block;width:100%;padding:10px 14px;border:0;border-radius:6px;background:#5b4fd6;color:#fff;font:inherit;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
.form-error{margin:0 0 16px;padding:10px 12px;border-radius:6px;background:#fdecec;color:#8f1f1f}
.form-error strong{display:block}
.attribution{margin:14px 0 0;text-align:center;color:#77777f;font-size:12px}
[hidden]{display:none!important}
`;

/** no value of a workflow is in this text: its settings come from the JSON block */
const PAGE_SCRIPT = `
(function () {
  var config = JSON.parse(document.getElementById('form-config').textContent);
  var form = document.getElementById('form');
  var button = document.getElementById('form-submit');
  var failure = document.getElementById('form-error');
  var ending = document.getElementById('form-ending');
  var EMAIL = /^[^\\s@]+@[^\\s@]+$/;

  function showError(group, text) {
    var box = group.querySelector('.field-error');
    box.textContent = text;
    box.hidden = !text;
  }

  function fileAccepted(file, accept) {
    if (!accept) return true;
    var name = file.name.toLowerCase();
    return accept.split(',').some(function (entry) {
      var extension = entry.trim().toLowerCase();
      if (!extension) return false;
      return name.endsWith(extension.charAt(0) === '.' ? extension : '.' + extension);
    });
  }

  function problem(group) {
    var type = group.getAttribute('data-type');
    var required = group.hasAttribute('data-required');
    if (type === 'checkbox') {
      var count = group.querySelectorAll('input:checked').length;
      var min = Number(group.getAttribute('data-min') || 0);
      var max = Number(group.getAttribute('data-max') || 0);
      if (required && !count) return 'This field is required';
      if (!required && !count) return '';
      if (min && max && min === max && count !== min) return 'Select ' + min + ' options';
      if (min && count < min) return 'Select at least ' + min + ' options';
      if (max && count > max) return 'Select at most ' + max + ' options';
      return '';
    }
    if (type === 'radio') {
      return required && !group.querySelector('input:checked') ? 'This field is required' : '';
    }
    var input = group.querySelector('input,select,textarea');
    if (type === 'file') {
      if (required && !input.files.length) return 'This field is required';
      var accept = input.getAttribute('accept');
      for (var i = 0; i < input.files.length; i++) {
        if (!fileAccepted(input.files[i], accept)) return 'This file type is not accepted';
      }
      return '';
    }
    var value = input.value;
    if (type === 'number' && input.validity && input.validity.badInput) return 'Enter a valid number';
    if (!value.trim()) return required ? 'This field is required' : '';
    if (type === 'email' && !EMAIL.test(value.trim())) return 'Enter a valid email address';
    return '';
  }

  function validate() {
    var first = null;
    form.querySelectorAll('[data-type]').forEach(function (group) {
      var text = problem(group);
      showError(group, text);
      if (text && !first) first = group;
    });
    if (first) {
      var control = first.querySelector('input,select,textarea');
      if (control) control.focus();
    }
    return !first;
  }

  function showFailure(title, text) {
    failure.querySelector('strong').textContent = title;
    failure.querySelector('span').textContent = text;
    failure.hidden = false;
    button.disabled = false;
  }

  function finish(text) {
    form.hidden = true;
    ending.querySelector('p').textContent = text;
    ending.hidden = false;
  }

  function answered(answer) {
    var redirect = answer.redirectURL || config.redirectUrl;
    if (redirect) {
      location.href = redirect;
      return;
    }
    finish(answer.formSubmittedText || config.submittedText);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    failure.hidden = true;
    if (!validate()) return;
    button.disabled = true;
    var headers = config.authToken ? { 'x-auth-token': config.authToken } : {};
    fetch(location.href, { method: 'POST', body: new FormData(form), headers: headers })
      .then(function (response) {
        if (response.status === 413) {
          showFailure(
            'Problem submitting response',
            'The files you are trying to upload are too large. Please reduce the total size and try again.',
          );
          return;
        }
        if (!response.ok) {
          showFailure(
            'Problem submitting response',
            'Please try again or contact support if the problem persists',
          );
          return;
        }
        return response.text().then(function (text) {
          var answer = {};
          try {
            answer = JSON.parse(text) || {};
          } catch (error) {
            answer = {};
          }
          answered(answer);
        });
      })
      .catch(function () {
        showFailure(
          'Problem submitting response',
          'Please try again or contact support if the problem persists',
        );
      });
  });
})();
`;

const htmlDocument = (title: string, body: SafeHtml, extra?: SafeHtml) =>
  write(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${new SafeHtml(STYLES)}</style>
${extra}
</head>
<body>
<main>${body}</main>
</body>
</html>
`);

/** an error or a plain message: the whole page is this text */
export function renderMessagePage(page: { title: string; message: string; detail?: string }): string {
  return htmlDocument(
    page.title,
    html`<div class="card">
<h1>${page.title}</h1>
<p class="description">${page.message}</p>
${page.detail ? html`<p class="description">${page.detail}</p>` : ''}
</div>`,
  );
}

function fieldLabel(field: FormPageField, id: string, tag: 'label' | 'legend' = 'label') {
  const className = field.requiredField ? 'label required' : 'label';
  return tag === 'legend'
    ? html`<legend class="${className}">${field.fieldLabel}</legend>`
    : html`<label class="${className}" for="${id}">${field.fieldLabel}</label>`;
}

const fieldError = html`<p class="field-error" hidden></p>`;

function choices(field: FormPageField, index: number, type: 'checkbox' | 'radio') {
  const chosen = new Set(type === 'checkbox' ? (field.values ?? []) : field.value ? [field.value] : []);
  return (field.fieldOptions?.values ?? []).map((entry) => {
    const option = String(entry.option ?? '');
    return html`<label class="choice"><input type="${type}" name="field-${index}" value="${option}"${
      chosen.has(option) ? new SafeHtml(' checked') : ''
    }>${option}</label>`;
  });
}

/** the attributes the page script reads for a selection limit */
function selectionLimits(field: FormPageField): SafeHtml {
  if (field.limitSelection === 'exact') {
    const count = Number(field.numberOfSelections ?? 1);
    return html` data-min="${count}" data-max="${count}"`;
  }
  if (field.limitSelection === 'range') {
    return html` data-min="${Number(field.minSelections ?? 0)}" data-max="${Number(field.maxSelections ?? 0)}"`;
  }
  return html``;
}

function renderField(field: FormPageField, index: number): SafeHtml {
  const id = `field-${index}`;
  const type = field.fieldType ?? 'text';
  const required = field.requiredField ? new SafeHtml(' data-required') : '';
  switch (type) {
    case 'html':
      return html`<div class="field">${new SafeHtml(sanitizeHtml(field.html ?? ''))}</div>`;
    case 'hiddenField':
      return html`<input type="hidden" name="${id}" value="${field.value ?? ''}">`;
    case 'checkbox':
    case 'radio':
      return html`<fieldset class="field" data-type="${type}"${required}${type === 'checkbox' ? selectionLimits(field) : ''}>
${fieldLabel(field, id, 'legend')}
${choices(field, index, type)}
${fieldError}
</fieldset>`;
    case 'dropdown': {
      const options = (field.fieldOptions?.values ?? []).map((entry) => {
        const option = String(entry.option ?? '');
        return html`<option value="${option}"${field.value === option ? new SafeHtml(' selected') : ''}>${option}</option>`;
      });
      return html`<div class="field" data-type="dropdown"${required}>
${fieldLabel(field, id)}
<select id="${id}" name="${id}"><option value="">Select an option</option>${options}</select>
${fieldError}
</div>`;
    }
    case 'textarea':
      return html`<div class="field" data-type="textarea"${required}>
${fieldLabel(field, id)}
<textarea id="${id}" name="${id}" placeholder="${field.placeholder ?? ''}">${field.value ?? ''}</textarea>
${fieldError}
</div>`;
    case 'file':
      return html`<div class="field" data-type="file"${required}>
${fieldLabel(field, id)}
<input type="file" id="${id}" name="${id}"${
        field.acceptFileTypes ? html` accept="${field.acceptFileTypes}"` : ''
      }${field.multipleFiles === false ? '' : new SafeHtml(' multiple')}>
${fieldError}
</div>`;
    default:
      return html`<div class="field" data-type="${type}"${required}>
${fieldLabel(field, id)}
<input type="${type}" id="${id}" name="${id}" placeholder="${field.placeholder ?? ''}" value="${field.value ?? ''}">
${fieldError}
</div>`;
  }
}

export function renderFormPage(data: FormPageData): string {
  const config = scriptJson({
    authToken: data.authToken ?? null,
    submittedText: data.submittedText,
    redirectUrl: data.redirectUrl ?? null,
  });
  const css = data.customCss
    ? html`<style>${new SafeHtml(sanitizeCustomCss(data.customCss))}</style>`
    : undefined;
  const description = data.description ? sanitizeHtml(data.description) : '';
  return htmlDocument(
    data.title,
    html`<div class="card">
${data.testMode ? html`<p class="notice">This is a test version of your form</p>` : ''}
<h1>${data.title}</h1>
${description ? html`<div class="description">${new SafeHtml(description)}</div>` : ''}
<form id="form" novalidate>
${data.fields.map(renderField)}
<div id="form-error" class="form-error" role="alert" hidden><strong></strong><span></span></div>
<button type="submit" id="form-submit">${data.buttonLabel}</button>
</form>
<div id="form-ending" hidden><p></p></div>
</div>
${data.attribution ? html`<p class="attribution">Form automated with Workflow</p>` : ''}
<script type="application/json" id="form-config">${config}</script>
<script>${new SafeHtml(PAGE_SCRIPT)}</script>`,
    css,
  );
}
