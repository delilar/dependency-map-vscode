import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPanelSizes } from '../../src/webview/panels';
test('desktop panels cannot consume the graph and restored dimensions are clamped', () => {
  const size = clampPanelSizes({ leftWidth: 3000, rightWidth: 3000, leftTopHeight: -10, toolbarHeight: 3000 }, 860, 800);
  assert(size.leftWidth + size.rightWidth <= 860 - 272);
  assert.equal(size.leftTopHeight, 85); assert.equal(size.toolbarHeight, 200);
});
test('narrow layout leaves usable heights for canvas and panels', () => {
  const size = clampPanelSizes({ narrowCanvasHeight: 5000 }, 640, 650);
  assert(size.narrowCanvasHeight >= 180 && size.narrowCanvasHeight <= 484);
  assert(size.leftWidth <= 484); assert(size.leftTopHeight >= 85);
});
