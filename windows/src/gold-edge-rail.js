const applyTheme = theme => {
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--rail-surface', theme.surface || theme.background);
  document.documentElement.style.setProperty('--rail-gold', theme.dark === false ? '#795725' : '#54442a');
};
window.openallGoldRail.watch(applyTheme);
window.openallGoldRail.read().then(applyTheme);
document.querySelector('#handle').addEventListener('click', () => window.openallGoldRail.expand());
