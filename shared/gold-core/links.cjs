const CTF_PAGE = 'https://www.ctfmall.com/todaygold';
const { CALENDAR_URLS } = require('./macro-calendar.cjs');
const LINKS = {
  gold: 'https://gold-api.com/assets/gold',
  goldHistory: 'https://goldprice.dev/prices/xau-usd',
  ctf: CTF_PAGE,
  ctfFallback: 'https://www.jinjia.com.cn/chowtaifook/',
  ctfHistory: 'https://www.sojinjia.cn/pinpai/zhoudafu/lishi',
  fx: 'https://frankfurter.dev/',
  DCOILWTICO: 'https://fred.stlouisfed.org/series/DCOILWTICO',
  DTWEXBGS: 'https://fred.stlouisfed.org/series/DTWEXBGS',
  DFII10: 'https://fred.stlouisfed.org/series/DFII10',
  news: 'https://news.un.org/zh/',
  ...CALENDAR_URLS,
};

module.exports = { LINKS };
