import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

// No StrictMode: its dev-only double mount would create and tear down a GPU device twice.
createRoot(document.getElementById('root')!).render(<App />)
