import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePhoneFolder, findIn, GUIDE, phoneRel } from '../public/phone-folders.js';

test('phoneRel strips the shared storage root, whatever it is called', () => {
  assert.equal(phoneRel('/storage/emulated/0'), '');
  assert.equal(phoneRel('/storage/emulated/0/DCIM/Camera'), 'DCIM/Camera');
  assert.equal(phoneRel('/sdcard/Download/'), 'Download');
  assert.equal(phoneRel('/storage/emulated/10/Music'), 'Music');
  assert.equal(phoneRel('/storage/emulated/01x'), null);
  assert.equal(phoneRel('/data/app'), null);
  assert.equal(phoneRel('C:\\Users'), null);
});

test('well-known folders get a tag and a kind', () => {
  const d = (p) => describePhoneFolder(`/storage/emulated/0/${p}`);
  assert.equal(d('DCIM').tag, 'Camera');
  assert.equal(d('dcim/camera').kind, 'yours');
  assert.equal(d('DCIM/Screenshots').tag, 'Screenshots');
  assert.equal(d('Pictures/Screenshots').tag, 'Screenshots');
  assert.equal(d('DCIM/.thumbnails').kind, 'clear');
  assert.equal(d('DCIM/11. Samsung S10 (2019 Mar - 2021 Sep)').tag, 'Photos');
  assert.equal(d('Download').tag, 'Downloads');
  assert.equal(d('Android').kind, 'info');
  assert.equal(d('Android/obb').tag, 'Game data');
  assert.equal(describePhoneFolder('/storage/emulated/0').tag, 'Shared storage');
  assert.equal(d('Some folder'), null);
  assert.equal(describePhoneFolder('C:\\DCIM'), null);
});

test('app folders are named after the app when the package is known', () => {
  const d = (p) => describePhoneFolder(`/storage/emulated/0/${p}`);
  assert.equal(d('Android/media/com.whatsapp').tag, 'WhatsApp media');
  assert.equal(d('Android/data/com.tencent.mm').tag, 'WeChat data');
  assert.equal(d('Android/obb/com.example.game').tag, 'Game data');
  assert.match(d('Android/data/com.example.app').about, /package com\.example\.app/);
  assert.equal(d('Android/media/com.whatsapp/WhatsApp/Media').tag, 'WhatsApp media');
  assert.equal(d('Android/media/com.whatsapp/WhatsApp/Media/.Statuses').kind, 'clear');
  assert.equal(d('Android/data/com.example.app/cache').kind, 'clear');
  assert.equal(d('Android/data/com.example.app/files/x/.cache').kind, 'clear');
});

test('every guide entry is described, and findIn walks a node ignoring case', () => {
  for (const [rel] of GUIDE) assert.ok(describePhoneFolder(`/sdcard/${rel}`), rel);
  const root = { children: [{ kind: 'dir', name: 'DCIM', size: 9, children: [{ kind: 'dir', name: 'Camera', size: 7 }] }] };
  assert.equal(findIn(root, 'dcim/camera').size, 7);
  assert.equal(findIn(root, 'Music'), null);
});
