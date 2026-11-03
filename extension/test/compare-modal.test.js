'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function ok(msg, val) {
  assert(val, msg);
  console.log('  ok   ' + msg);
}

const ROOT = path.join(__dirname, '..', '..');
const buttonSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'button.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

async function runTests() {
  console.log('--- 1. Compare Button & Modal Removal in Content Script ---');
  ok('compareIcon is removed from button.js', !buttonSrc.includes('function compareIcon('));
  ok('createCompareButton is removed from button.js', !buttonSrc.includes('function createCompareButton('));
  ok('openModelComparisonModal is removed from button.js', !buttonSrc.includes('function openModelComparisonModal('));
  ok('modal root is not in button.js', !buttonSrc.includes('__xwap-compare-modal-root'));
  ok('OPEN_COMPARE_MODAL listener is removed', !buttonSrc.includes('OPEN_COMPARE_MODAL'));

  console.log('\n--- 2. Popup Integration - Compare Card Removed ---');
  ok('popup.html does not contain #compareCard', !popupHtml.includes('id="compareCard"'));
  ok('popup.html does not contain #compareRunBtn', !popupHtml.includes('id="compareRunBtn"'));
  ok('popup.js does not contain compareRunBtn listener', !popupJs.includes('ui.compareRunBtn'));

  console.log('\n--- 3. Single Active Model Selection in Popup ---');
  ok('popup.html contains #groqModelSelect', popupHtml.includes('id="groqModelSelect"'));
  ok('openai/gpt-oss-120b is the finalized default option', popupHtml.includes('value="openai/gpt-oss-120b">GPT-OSS 120B (Default'));
  ok('dropdown includes other models (Qwen, GPT-OSS 20B, Allam)', popupHtml.includes('qwen/qwen3.8-27b') && popupHtml.includes('openai/gpt-oss-20b') && popupHtml.includes('allam-2-7b'));

  console.log('\n--- 4. Action Popup (Not Sidebar) Configuration ---');
  ok('action.default_popup is set to popup/popup.html', manifest.action && manifest.action.default_popup === 'popup/popup.html');
  ok('side_panel is removed from manifest', manifest.side_panel === undefined);
  ok('sidePanel permission is removed', !manifest.permissions.includes('sidePanel'));

  console.log('\nALL VERIFICATION TESTS PASSED');
}

runTests().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
