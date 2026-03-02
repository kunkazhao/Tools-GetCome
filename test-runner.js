// test-runner.js
import(chrome.runtime.getURL("background.js")).then(bg => {
    console.log("Loaded bg script");
}).catch(e => console.error(e));
