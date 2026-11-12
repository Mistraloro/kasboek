import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './i18n'
import { App } from './App'
import { applyThemeToDocument } from './lib/settings'

// Match the system theme until settings load, so there's no white flash.
applyThemeToDocument('system')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
