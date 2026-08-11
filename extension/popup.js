// popup.js — 弹窗交互

const CONFIG_KEY = 'hermes_config';

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function classifyUrl(url) {
  const host = url.includes('://') ? url.split('/')[2] : url;
  if (host.includes('bilibili') || host.includes('b23.tv')) return 'B站';
  if (host.includes('tieba.baidu.com')) return '贴吧';
  if (host.includes('xiaoheihe')) return '小黑盒';
  if (host.includes('zhihu')) return '知乎';
  if (host.includes('douban')) return '豆瓣';
  if (host.includes('weibo')) return '微博';
  if (host.includes('jinritemai') || host.includes('douyin')) return '千川/抖音';
  if (host.includes('github.com')) return 'GitHub';
  return '网页';
}

// 读取配置
async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return stored[CONFIG_KEY] || { autoCapture: false };  // V2.1: 默认手动模式
}

// 保存配置
async function setConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

// 更新自动捕获状态显示
async function updateAutoStatus() {
  const config = await getConfig();
  const badge = document.getElementById('autoStatus');
  const subtitle = document.querySelector('.subtitle');
  if (config.autoCapture) {
    badge.textContent = '开启';
    badge.className = 'badge';
    subtitle.textContent = '自动捕获中 · 随时对话';
  } else {
    badge.textContent = '关闭';
    badge.className = 'badge off';
    subtitle.textContent = '手动捕获 · 点击按钮触发';
  }
}

// 切换自动捕获
async function toggleAutoCapture() {
  const config = await getConfig();
  const newVal = !config.autoCapture;
  await setConfig({ autoCapture: newVal });
  await updateAutoStatus();
  showToast(newVal ? '自动捕获已开启（不滚动页面）' : '自动捕获已关闭');
}

async function updatePageInfo() {
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
      document.getElementById('hasPage').textContent = '无';
      document.getElementById('pageTitle').textContent = '没有可用的浏览器页面';
      document.getElementById('pageUrl').textContent = '';
      document.getElementById('pageType').textContent = '';
      return;
    }
    document.getElementById('hasPage').textContent = '已就绪';
    document.getElementById('pageTitle').textContent = tab.title || '未命名页面';
    document.getElementById('pageUrl').textContent = tab.url;
    document.getElementById('pageType').textContent = '类型: ' + classifyUrl(tab.url);
  } catch (e) {}
}

// 深度捕获（含滚动+延迟+API调用）
async function triggerDeepCapture() {
  const btn = document.getElementById('captureNowBtn');
  btn.disabled = true;
  btn.textContent = '深度捕获中(约5秒)…';

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      showToast('没有可捕获的页面', 'error');
      return;
    }
    chrome.runtime.sendMessage({
      action: 'triggerCapture',
      tabId: tab.id,
      deep: true,
    }, (resp) => {
      btn.disabled = false;
      btn.textContent = '⚡ 深度捕获当前页';
      showToast('✅ 已触发深度捕获');
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '⚡ 深度捕获当前页';
    showToast('捕获失败', 'error');
  }
}

// 快速捕获（不滚动；force=true 绕过内容去重——用户手动点就是要拿一份完整的）
async function quickCapture() {
  const btn = document.getElementById('screenshotBtn');
  btn.disabled = true;
  btn.textContent = '快速捕获中…';

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      showToast('没有可捕获的页面', 'error');
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { action: 'captureQuick', force: true });
    if (resp && resp.title) {
      chrome.runtime.sendMessage({ action: 'saveCapture', data: resp });
      showToast('✅ 已捕获');
    } else {
      showToast('页面不支持', 'error');
    }
  } catch (e) {
    showToast('捕获失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ 快速捕获';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updatePageInfo();
  updateAutoStatus();
  document.getElementById('toggleRow').addEventListener('click', toggleAutoCapture);
  document.getElementById('captureNowBtn').addEventListener('click', triggerDeepCapture);
  document.getElementById('screenshotBtn').addEventListener('click', quickCapture);
});