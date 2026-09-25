import React from 'react';
import './index.css';
import './theme.css';
import { render } from 'react-dom';
import { App } from './App';
import { AppDialogHost } from './components/shared/AppDialog';

// The app's own message and question boxes — see AppDialog.tsx.
render(<><App /><AppDialogHost /></>, document.getElementById('root'));