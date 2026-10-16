import xml2js from 'xml2js';

const list = value => value ? Array.isArray(value) ? value : [value] : [];
const label = value => typeof value === 'string' && !/^\d+$/.test(value.trim()) ? value.trim().slice(0, 120) : '';
export function mainDvrChannel(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 99999999) throw new Error('Invalid DVR channel');
  return String(number >= 100 ? Math.floor(number / 100) * 100 + 1 : number);
}
export async function parseDvrChannels(streamXml, namesXml = '') {
  const parser = new xml2js.Parser({ explicitArray: false });
  const data = await parser.parseStringPromise(streamXml);
  const channels = list(data.StreamingChannelList?.StreamingChannel).filter(channel => /^\d{1,8}$/.test(String(channel?.id || '')));
  const ids = new Set(channels.map(channel => String(channel.id))), names = new Map();
  if (namesXml) {
    try {
      const named = await parser.parseStringPromise(namesXml);
      for (const channel of list(named.InputProxyChannelList?.InputProxyChannel || named.VideoInputChannelList?.VideoInputChannel)) {
        const name = label(channel.name || channel.channelName);
        if (name) names.set(String(channel.id), name);
      }
    } catch { /* Optional friendly-name discovery must not break playback. */ }
  }
  return channels.filter(channel => mainDvrChannel(channel.id) === String(channel.id)).map(channel => {
    const id = String(channel.id), index = Number(id) >= 100 ? Math.floor(Number(id) / 100) : Number(id);
    const substreamId = Number(id) >= 100 && ids.has(String(Number(id) + 1)) ? String(Number(id) + 1) : null;
    return { id, name: names.get(String(index)) || label(channel.channelName) || `镜头 ${index}`, substreamId,
      resolution: channel.Video?.videoResolutionWidth ? `${channel.Video.videoResolutionWidth}x${channel.Video.videoResolutionHeight}` : '',
      codec: String(channel.Video?.videoCodecType || channel.Video?.videoEncoding || '') };
  });
}
