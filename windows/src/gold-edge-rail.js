const applyTheme = theme => {
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--rail-surface', theme.surface || theme.background);
  document.documentElement.style.setProperty('--gold-ink', theme.dark === false ? '#7d520f' : '#fcc76b');
};
window.openallGoldRail.watch(applyTheme);
window.openallGoldRail.read().then(applyTheme);
document.querySelector('#handle').addEventListener('click', () => window.openallGoldRail.expand());
