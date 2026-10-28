import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { lang, langTag, setLang, t } from './i18n';
import './styles.css';

const applyDocLang = () => {
  document.documentElement.lang = langTag();
  document.title = t('协作中枢 · 控制台');
};
applyDocLang();

// 切换语言时用 key 重挂整棵树，模块级的文案和日期格式都跟着换
function Root() {
  const [code, setCode] = useState(lang);
  return (
    <App
      key={code}
      onLang={(next) => {
        setLang(next);
        applyDocLang();
        setCode(lang());
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
