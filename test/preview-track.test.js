import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordTracks, parseTrackFrameRate, substreamTrackOf } from '../lib/record-tracks.js';
import { parseMaxFrameRate, DEFAULT_PREVIEW_FPS } from '../lib/stream-params.js';

// 真机片段（DS-7808N-Q1 V4.82.100）：只有主码流 track，没有 102/202
const TRACKS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TrackList version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<Track><id>101</id><Channel>101</Channel><Enable>false</Enable>
<Description>trackType=standard,contentType=video,codecType=H.264-BP,resolution=3200x1800,framerate=25.0 fps,bitrate=8192 kbps</Description></Track>
<Track><id>201</id><Channel>201</Channel><Enable>false</Enable>
<Description>trackType=standard,contentType=video,codecType=H.264-BP,resolution=3200x1800,framerate=25.0 fps,bitrate=8192 kbps</Description></Track>
</TrackList>`;

const TRACKS_XML_WITH_SUB = `<?xml version="1.0" encoding="UTF-8"?>
<TrackList version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<Track><id>201</id><Channel>201</Channel></Track>
<Track><id>202</id><Channel>202</Channel>
<Description>resolution=1280x720,framerate=20.0 fps,bitrate=512 kbps</Description></Track>
</TrackList>`;

describe('parseRecordTracks', () => {
  it('collects track ids with their frame rates', async () => {
    const tracks = await parseRecordTracks(TRACKS_XML);
    assert.deepEqual([...tracks.keys()].sort(), ['101', '201']);
    assert.equal(tracks.get('201').fps, 25);
  });

  it('detects a substream track when the device records one', async () => {
    const tracks = await parseRecordTracks(TRACKS_XML_WITH_SUB);
    assert.ok(tracks.has('202'));
    assert.equal(tracks.get('202').fps, 20);
  });

  it('handles a single-track response (xml2js collapses it to an object)', async () => {
    const xml = '<TrackList><Track><id>201</id></Track></TrackList>';
    const tracks = await parseRecordTracks(xml);
    assert.deepEqual([...tracks.keys()], ['201']);
    assert.equal(tracks.get('201').fps, null);
  });

  it('returns an empty map when there is no track list', async () => {
    const tracks = await parseRecordTracks('<TrackList></TrackList>');
    assert.equal(tracks.size, 0);
  });
});

describe('parseTrackFrameRate', () => {
  it('reads the framerate out of the description blob', () => {
    assert.equal(parseTrackFrameRate('resolution=3200x1800,framerate=25.0 fps,bitrate=8192 kbps'), 25);
    assert.equal(parseTrackFrameRate('framerate=12.5 fps'), 12.5);
  });

  it('returns null when absent or implausible', () => {
    assert.equal(parseTrackFrameRate('resolution=3200x1800'), null);
    assert.equal(parseTrackFrameRate('framerate=0.0 fps'), null);
    assert.equal(parseTrackFrameRate('framerate=999 fps'), null);
    assert.equal(parseTrackFrameRate(undefined), null);
  });
});

describe('substreamTrackOf', () => {
  it('maps a main-stream track to its substream', () => {
    assert.equal(substreamTrackOf('201'), '202');
    assert.equal(substreamTrackOf('101'), '102');
    assert.equal(substreamTrackOf('1601'), '1602');
  });

  it('returns null for ids that are not main-stream tracks', () => {
    assert.equal(substreamTrackOf('202'), null); // already a substream
    assert.equal(substreamTrackOf('2'), null);   // bare channel number
    assert.equal(substreamTrackOf('abc'), null);
  });
});

describe('parseMaxFrameRate', () => {
  it('converts hikvision fps*100 to fps', () => {
    assert.equal(parseMaxFrameRate('<maxFrameRate>2000</maxFrameRate>'), 20);
    assert.equal(parseMaxFrameRate('<maxFrameRate>2500</maxFrameRate>'), 25);
  });

  it('returns null for 0 (device reports "unlimited")', () => {
    assert.equal(parseMaxFrameRate('<maxFrameRate>0</maxFrameRate>'), null);
  });

  it('returns null when the field is missing or out of range', () => {
    assert.equal(parseMaxFrameRate('<videoCodecType>H.264</videoCodecType>'), null);
    assert.equal(parseMaxFrameRate('<maxFrameRate>9900</maxFrameRate>'), null);
    assert.equal(parseMaxFrameRate(''), null);
  });

  it('exposes a sane default for callers', () => {
    assert.equal(DEFAULT_PREVIEW_FPS, 20);
  });
});
