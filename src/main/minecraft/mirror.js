const config = require('../config');

const REPLACEMENTS = [
  ['https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://libraries.minecraft.net', 'https://bmclapi2.bangbang93.com/maven'],
  ['https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets'],
  ['https://launcher.mojang.com', 'https://bmclapi2.bangbang93.com'],
];

function mirrorUrl(url) {
  if (config.get('mirror') !== 'bmcl') return url;
  let result = url;
  for (const [from, to] of REPLACEMENTS) {
    if (result.startsWith(from)) {
      result = to + result.slice(from.length);
      break;
    }
  }
  return result;
}

module.exports = { mirrorUrl };
