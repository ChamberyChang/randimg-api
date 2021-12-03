import _, { random } from 'lodash';
import { getLocalReverseProxyURL } from './pximg';
import { URL } from 'url';
import './jimpPlugin';
import Jimp from 'jimp';
const Axios = require('./axiosProxy');

const API_URL = global.config.sendImg.url;; //A public pixiv image dataset api

const PIXIV_404 = Symbol('Pixiv image 404'); //when 404 is returned

async function imgAntiShielding(url) {
  const setting = global.config.sendImg;
  const proxy = setting.pximgProxy.trim();
  const img = await Jimp.read(
    proxy ? Buffer.from(await Axios.get(url, { responseType: 'arraybuffer' }).then(r => r.data)) : url
  );

  switch (Number(global.config.sendImg.antiShielding)) {
    case 1:
      const [w, h] = [img.getWidth(), img.getHeight()];
      const pixels = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ];
      for (const [x, y] of pixels) {
        img.setPixelColor(Jimp.rgbaToInt(random(255), random(255), random(255), 1), x, y);
      }
      break;

    case 2:
      img.simpleRotate(90);
      break;
  }

  return (await img.getBase64Async(Jimp.AUTO)).split(',')[1];
}

// the size of image is limited to 4M 
function checkBase64RealSize(base64) {
  return base64.length && base64.length * 0.75 < 4000000;
}

async function getAntiShieldingBase64(url, fallbackUrl) {
  try {
    const origBase64 = await imgAntiShielding(url);
    if (checkBase64RealSize(origBase64)) return origBase64;
  } catch (error) {
    // the original image is too big
  }
  if (!fallbackUrl) return;
  const m1200Base64 = await imgAntiShielding(fallbackUrl);
  if (checkBase64RealSize(m1200Base64)) return m1200Base64;
}

function sendImg(context, at = true) {
  const sendImgRegExec = context.message;
  if (!sendImgRegExec) return false;

  const setting = global.config.sendImg;
  const proxy = setting.pximgProxy.trim();
  const isGroupMsg = context.message_type === 'group';

  const regGroup = sendImgRegExec.groups || {};
  const r18 = regGroup.r18 && !(isGroupMsg && setting.r18OnlyInWhite && !setting.whiteGroup.includes(context.group_id));
  const keyword = regGroup.keyword ? regGroup.keyword.split('&') : undefined;

  let success = false;
  Axios.post(API_URL, { r18, tag: keyword, size: ['original', 'regular'], proxy: null })
    .then(ret => ret.data)
    .then(async ret => {
      if (ret.error) return global.replyMsg(context, ret.error, at);
      if (!ret.data.length) return global.replyMsg(context, 'No results', at);

      const sendImg = ret.data[0];
      const sendImgUrl = setting.size1200 ? sendImg.urls.regular : sendImg.urls.original;
      const urlMsgs = [`https://pixiv.net/i/${sendImg.pid} (p${sendImg.p})`];

      if (
        r18 &&
        setting.r18OnlyUrl[
          context.message_type === 'private' && context.sub_type !== 'friend' ? 'temp' : context.message_type
        ]
      ) {
        global.replyMsg(context, urlMsgs.join('\n'), false, at);
        return;
      }
      global.replyMsg(context, urlMsgs.join('\n'), at);

      const getReqUrl = url => (proxy ? getImgUrlByTemplate(proxy, sendImg, url) : getLocalReverseProxyURL(url));
      const url = getReqUrl(sendImgUrl);
      const fallbackUrl = setting.size1200 ? undefined : getReqUrl(sendImg.urls.regular);

      // 反和谐
      const base64 =
        isGroupMsg &&
        setting.antiShielding &&
        (await getAntiShieldingBase64(url, fallbackUrl).catch(e => {
          console.error(`${global.getTime()} [error] anti shielding`);
          console.error(url);
          console.error(e);
          if (String(e).includes('Could not find MIME for Buffer') || String(e).includes('status code 404')) {
            return PIXIV_404;
          }
          global.replyMsg(context, 'Modifying Error');
        }));

      if (base64 === PIXIV_404) {
        global.replyMsg(context, 'Sending Error');
        return;
      }

      const imgType = delTime === -1 ? 'flash' : null;

      success = true;
    })
    .catch(e => {
      console.error(`${global.getTime()} [error]`);
      console.error(e);
      global.replyMsg(context, 'Server Error', at);
    })
    .finally(() => {
      if (!success) console.log(context.user_id);
    });

  return true;
}

export default sendImg;

function getImgUrlByTemplate(tpl, sendImg, url) {
  const path = new URL(url).pathname.replace(/^\//, '');
  if (!/{{.+}}/.test(tpl)) return new URL(path, tpl).href;
  return _.template(tpl, { interpolate: /{{([\s\S]+?)}}/g })({ path, ..._.pick(sendImg, ['pid', 'p', 'uid', 'ext']) });
}
