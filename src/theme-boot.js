/* Runs before first paint: pick the saved theme, else follow the system. */
(function(){var t=null;try{t=localStorage.getItem('veil-theme');}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;})();
