import React from 'react';
import './index.css';
import './theme.css';
import { render } from 'react-dom';
import { App } from './App';
import { AppDialogHost } from './components/shared/AppDialog';

import { TemplatesOverview } from './components/TemplateCreation/TemplatesOverview';

// `?view=templates&projectId=…` is the all-templates table, opened in a tab of
// its own from Create Template; anything else is the app.
const query = new URLSearchParams(window.location.search);
const page = query.get('view') === 'templates'
  ? <TemplatesOverview projectId={query.get('projectId') ?? ''} />
  : <App />;

// The app's own message and question boxes — see AppDialog.tsx.
render(<>{page}<AppDialogHost /></>, document.getElementById('root'));