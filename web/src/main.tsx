import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/ui.css';
import './styles/map.css';
import './styles/geo.css';
import './styles/app.css';
import './styles/chat.css';
import './styles/auth.css';
import './styles/engineer.css';
import './styles/workspace.css';

import { desktop } from './lib/desktop';
desktop.markReady();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
