<script setup>
import DefaultTheme from 'vitepress/theme';
import {useData} from 'vitepress';
import {computed} from 'vue';
const {lang}=useData();
const english=computed(()=>lang.value==='en');
const { Layout } = DefaultTheme;
const inOpenPlatform = import.meta.env.VITE_REAI_OPEN_PLATFORM === '1';
</script>

<template>
  <Layout>
    <template #layout-bottom>
      <!-- 完整导航离开文档路由；由主题管理，客户端换页后仍保留。 -->
      <a v-if="inOpenPlatform" :href="english ? '/en/' : '/'" target="_self" class="open-platform-return">{{ english ? '← Back to ReAI Open' : '← 返回 ReAI Open' }}</a>
    </template>
  </Layout>
</template>

<style>
.open-platform-return {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 50;
  padding: 10px 16px;
  background: #232323;
  color: #fff !important;
  font: 12px/24px sans-serif;
  border-radius: 6px;
  box-shadow: 0 3px 14px #0002;
}
.open-platform-return:focus-visible { outline: 3px solid #58c049; outline-offset: 3px; }
</style>
