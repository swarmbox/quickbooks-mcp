import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSafeErrorText } from './safe-error.js';

test('axios error carrying an Authorization header never leaks the token', () => {
  // Shape of a real axios error: config.headers.Authorization plus a toJSON()
  // that serializes config — the exact vector this fix closes.
  const token = 'Bearer eyJhbGciOiJ.SECRETACCESSTOKEN.signature';
  const config = {
    method: 'post',
    url: 'https://quickbooks.api.intuit.com/v3/company/123/query',
    headers: { Authorization: token },
  };
  const axiosError = Object.assign(
    new Error('Request failed with status code 401'),
    {
      isAxiosError: true,
      response: { status: 401 },
      config,
      // axios' toJSON() serializes config — the exact leak vector.
      toJSON: () => ({ message: 'Request failed with status code 401', config }),
    },
  );

  const text = toSafeErrorText(axiosError);
  assert.doesNotMatch(text, /Bearer/);
  assert.doesNotMatch(text, /SECRETACCESSTOKEN/);
  assert.doesNotMatch(text, /Authorization/i);
  assert.match(text, /HTTP 401/);
});

test('QB Fault error yields code / message / detail and hides any attached token', () => {
  const qbError = {
    Fault: {
      Error: [
        {
          code: '2050',
          Message: 'Object Not Found',
          Detail: 'Object Not Found : Something you requested is missing',
        },
      ],
    },
    // Even if a raw request config were attached, it must never surface.
    config: { headers: { Authorization: 'Bearer LEAKED' } },
  };

  const text = toSafeErrorText(qbError);
  assert.match(text, /2050/);
  assert.match(text, /Object Not Found/);
  assert.doesNotMatch(text, /Bearer/);
  assert.doesNotMatch(text, /LEAKED/);
});

test('plain Error returns its message only', () => {
  assert.equal(toSafeErrorText(new Error('boom')), 'boom');
});

test('non-object throwable falls back to a safe form', () => {
  assert.equal(toSafeErrorText('plain string failure'), 'plain string failure');
  assert.equal(toSafeErrorText(undefined), 'Unknown error');
});
