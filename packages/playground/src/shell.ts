import { inspectorHtml as shell } from "../../dev/src/shell.js";
export const inspectorHtml = shell
  .replace(
    '<script type="module" src="/inspector.js"></script>',
    '<script type="module" src="./playground.js"></script>',
  )
  .replace("Unofficial · local files and snapshot", "Unofficial · files stay in this browser")
  .replace(
    "<header>",
    "<style>header{height:160px}main{height:calc(100vh - 160px)}iframe{height:calc(100vh - 200px)}#inputs{display:flex;flex-wrap:wrap;gap:8px;align-items:center}#inputs label{cursor:pointer;border:1px solid #d6dde7;border-radius:6px;padding:7px 10px}#input-status{font-size:12px;color:#64748b;flex:1}#input-status[data-state=error]{color:#b42318}#inputs input{display:none}</style><header>",
  )
  .replace(
    '<form id="controls">',
    '<div id="inputs"><label>Theme zip<input id="theme-zip" type="file" accept=".zip"></label><button id="open-theme-folder" type="button">Theme folder</button><input id="theme-folder" type="file" webkitdirectory multiple><label>Snapshot zip<input id="snapshot-zip" type="file" accept=".zip"></label><button id="open-snapshot-folder" type="button">Snapshot folder</button><input id="snapshot-folder" type="file" webkitdirectory multiple><button id="default-snapshot" type="button">Default fixture</button><button id="reload-folder" type="button" disabled>Reload folder</button><span id="input-status" role="status"></span></div><form id="controls">',
  )
  .replace(
    'sandbox="allow-scripts allow-same-origin allow-forms"',
    'sandbox="allow-scripts allow-forms"',
  )
  .replace('data-state="loading">Starting…', 'data-state="idle">Choose a theme to start.');
