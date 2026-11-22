const applyTheme = theme => {
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--on-accent', theme.onAccent);
};
window.openallGoldRail.watch(applyTheme);
window.openallGoldRail.read().then(applyTheme);
document.querySelector('#handle').addEventListener('click', () => window.openallGoldRail.expand());
