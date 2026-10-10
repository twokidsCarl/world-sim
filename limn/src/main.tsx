import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// Handle for poking at the app from the console.
import { useStore } from './state/store'
import { stage } from './ui/Stage'
Object.assign(window, { limn: { stage, store: useStore } })
