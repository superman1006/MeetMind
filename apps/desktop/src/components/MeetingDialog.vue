<script setup lang="ts">
import { onMounted, ref } from "vue";

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog ref="dialog" class="meeting-dialog popup-dialog" aria-labelledby="meeting-dialog-title" @cancel.prevent="emit('close')">
    <header>
      <div class="dialog-heading">
        <h2 id="meeting-dialog-title">{{ title }}</h2>
        <slot name="header-details" />
      </div>
      <button type="button" class="close" aria-label="关闭" @click="emit('close')">×</button>
    </header>
    <div class="dialog-body"><slot /></div>
    <footer v-if="$slots.footer"><slot name="footer" /></footer>
  </dialog>
</template>

<style scoped>
.meeting-dialog {
  width: min(var(--meeting-dialog-width, 540px), calc(100vw - 28px));
  max-height: min(730px, 85dvh);
  padding: 0;
  overflow: hidden;
  background: var(--bg-chat);
  color: var(--text-main);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lift);
}
.meeting-dialog[open] { display: flex; flex-direction: column; }
.meeting-dialog::backdrop { background: rgb(12 17 28 / 52%); }
header, footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  gap: 12px;
  padding: 14px var(--meeting-dialog-inset, 20px);
}
header { border-bottom: 1px solid var(--border); align-items: flex-start; }
.dialog-heading { min-width: 0; }
h2 { font-size: var(--meeting-dialog-title-size, 17px); margin: 0; font-weight: 650; line-height: 32px; }
.close {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--text-dim);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 23px;
  line-height: 1;
}
.close:hover { background: var(--bg-elevated); color: var(--text-main); }
.close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dialog-body {
  min-height: 0;
  padding: 16px var(--meeting-dialog-inset, 20px);
  overflow: auto;
  overscroll-behavior: contain;
}
footer { border-top: 1px solid var(--border); justify-content: flex-end; }
</style>
