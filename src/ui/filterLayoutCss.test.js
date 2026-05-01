'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('filter sidebar checkbox inputs do not inherit text input min-width', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'main.css'), 'utf8');

  assert.equal(
    /\.filter-group\s+input,\s*\.filter-group\s+select\s*\{[^}]*min-width:\s*150px/i.test(css),
    false,
    'source checkboxes inherit the broad .filter-group input min-width and expand the sidebar'
  );

  assert.match(
    css,
    /\.source-checkbox\s+input\[type="checkbox"\]\s*\{[^}]*min-width:\s*0/i,
    'source checkboxes need an explicit min-width reset'
  );
});
