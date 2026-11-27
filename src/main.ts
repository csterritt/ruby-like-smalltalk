import { createApp } from "vue";
import App from "./App.vue";
import EditorWindow from "./EditorWindow.vue";

const editor = new URLSearchParams(location.search).get("editor");
createApp(editor ? EditorWindow : App).mount("#app");
