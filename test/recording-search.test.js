import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchXml,
  extractSizeFromURI,
  parseSearchResponse,
} from '../lib/recording-search.js';

describe('buildSearchXml', () => {
  it('should produce valid XML with all parameters', () => {
    const xml = buildSearchXml(
      'test-uuid-123',
      '201',
      '2026-05-07T00:00:00Z',
      '2026-05-07T23:59:59Z',
      40,
      0
    );
    assert.ok(xml.includes('<searchID>test-uuid-123</searchID>'));
    assert.ok(xml.includes('<trackID>201</trackID>'));
    assert.ok(xml.includes('<startTime>2026-05-07T00:00:00Z</startTime>'));
    assert.ok(xml.includes('<endTime>2026-05-07T23:59:59Z</endTime>'));
    assert.ok(xml.includes('<maxResults>40</maxResults>'));
    // Note: DVR uses "searchResultPostion" (typo - missing 'i')
    assert.ok(xml.includes('<searchResultPostion>0</searchResultPostion>'));
    assert.ok(xml.includes('//recordType.meta.std-cgi.com'));
  });

  it('should use the provided searchResultPosition for pagination', () => {
    const xml = buildSearchXml('uuid', '201', '2026-05-07T00:00:00Z', '2026-05-07T23:59:59Z', 40, 80);
    assert.ok(xml.includes('<searchResultPostion>80</searchResultPostion>'));
  });
});

describe('extractSizeFromURI', () => {
  it('should extract size from a typical playbackURI', () => {
    const uri = 'rtsp://192.0.2.200/Streaming/tracks/201/?starttime=20260507T175817Z&endtime=20260507T181347Z&name=ch201_01&size=929491916';
    assert.equal(extractSizeFromURI(uri), 929491916);
  });

  it('should extract size when it is the only parameter', () => {
    const uri = 'rtsp://192.0.2.200/Streaming/tracks/201/?size=12345';
    assert.equal(extractSizeFromURI(uri), 12345);
  });

  it('should return 0 when size parameter is missing', () => {
    const uri = 'rtsp://192.0.2.200/Streaming/tracks/201/?starttime=20260507T175817Z';
    assert.equal(extractSizeFromURI(uri), 0);
  });

  it('should return 0 for empty string', () => {
    assert.equal(extractSizeFromURI(''), 0);
  });

  it('should handle size in the middle of parameters', () => {
    const uri = 'rtsp://ip/path?name=test&size=555666&other=val';
    assert.equal(extractSizeFromURI(uri), 555666);
  });
});

describe('parseSearchResponse', () => {
  it('should parse a single match item', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult>
  <responseStatus>true</responseStatus>
  <numOfMatches>1</numOfMatches>
  <totalMatches>1</totalMatches>
  <matchList>
    <searchMatchItem>
      <timeSpan>
        <startTime>2026-05-07T17:58:17Z</startTime>
        <endTime>2026-05-07T18:13:47Z</endTime>
      </timeSpan>
      <mediaSegmentDescriptor>
        <playbackURI>rtsp://192.0.2.200/Streaming/tracks/201/?starttime=20260507T175817Z&amp;endtime=20260507T181347Z&amp;name=ch201_01&amp;size=929491916</playbackURI>
      </mediaSegmentDescriptor>
    </searchMatchItem>
  </matchList>
</CMSearchResult>`;

    const result = await parseSearchResponse(xml, '201');
    assert.equal(result.numOfMatches, 1);
    assert.equal(result.totalMatches, 1);
    assert.equal(result.files.length, 1);

    const file = result.files[0];
    assert.equal(file.startTime, '2026-05-07T17:58:17Z');
    assert.equal(file.endTime, '2026-05-07T18:13:47Z');
    assert.equal(file.size, 929491916);
    assert.equal(file.channel, '201');
    assert.ok(file.playbackURI.includes('Streaming/tracks/201'));
  });

  it('should parse multiple match items', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult>
  <responseStatus>true</responseStatus>
  <numOfMatches>2</numOfMatches>
  <totalMatches>2</totalMatches>
  <matchList>
    <searchMatchItem>
      <timeSpan>
        <startTime>2026-05-07T17:58:17Z</startTime>
        <endTime>2026-05-07T18:13:47Z</endTime>
      </timeSpan>
      <mediaSegmentDescriptor>
        <playbackURI>rtsp://ip/path?size=100000</playbackURI>
      </mediaSegmentDescriptor>
    </searchMatchItem>
    <searchMatchItem>
      <timeSpan>
        <startTime>2026-05-07T18:13:47Z</startTime>
        <endTime>2026-05-07T18:30:00Z</endTime>
      </timeSpan>
      <mediaSegmentDescriptor>
        <playbackURI>rtsp://ip/path?size=200000</playbackURI>
      </mediaSegmentDescriptor>
    </searchMatchItem>
  </matchList>
</CMSearchResult>`;

    const result = await parseSearchResponse(xml, '201');
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].size, 100000);
    assert.equal(result.files[1].size, 200000);
    assert.equal(result.files[1].startTime, '2026-05-07T18:13:47Z');
  });

  it('should handle empty results (responseStatus false)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult>
  <responseStatus>false</responseStatus>
  <numOfMatches>0</numOfMatches>
  <totalMatches>0</totalMatches>
</CMSearchResult>`;

    const result = await parseSearchResponse(xml, '201');
    assert.equal(result.files.length, 0);
    assert.equal(result.numOfMatches, 0);
  });

  it('should handle NO MATCHES response', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult>
  <responseStatus>NO MATCHES</responseStatus>
  <numOfMatches>0</numOfMatches>
  <totalMatches>0</totalMatches>
</CMSearchResult>`;

    const result = await parseSearchResponse(xml, '201');
    assert.equal(result.files.length, 0);
  });

  it('should throw on invalid XML (missing CMSearchResult)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><SomeOtherRoot></SomeOtherRoot>`;
    await assert.rejects(
      () => parseSearchResponse(xml, '201'),
      /Invalid search response/
    );
  });

  it('should handle numOfMatches > 0 but missing matchList gracefully', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult>
  <responseStatus>true</responseStatus>
  <numOfMatches>1</numOfMatches>
  <totalMatches>1</totalMatches>
</CMSearchResult>`;

    const result = await parseSearchResponse(xml, '201');
    assert.equal(result.files.length, 0);
  });

  it('should extract playbackURI from item level if not in mediaSegmentDescriptor', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult>
  <responseStatus>true</responseStatus>
  <numOfMatches>1</numOfMatches>
  <totalMatches>1</totalMatches>
  <matchList>
    <searchMatchItem>
      <timeSpan>
        <startTime>2026-05-07T10:00:00Z</startTime>
        <endTime>2026-05-07T10:15:00Z</endTime>
      </timeSpan>
      <playbackURI>rtsp://ip/path?size=500000</playbackURI>
    </searchMatchItem>
  </matchList>
</CMSearchResult>`;

    const result = await parseSearchResponse(xml, '101');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].size, 500000);
    assert.equal(result.files[0].channel, '101');
  });
});
