import React from 'react';
import './index.css';
import './theme.css';
import { render } from 'react-dom';
import { App } from './App';
import { AppDialogHost } from './components/shared/AppDialog';

import { TemplatesOverview } from './components/TemplateCreation/TemplatesOverview';
import { TemplateGraphicPage } from './components/TemplateCreation/TemplateGraphicPage';

// `?view=templates&projectId=…` is the all-templates table, opened in a tab of
// its own from Create Template; anything else is the app.
const query = new URLSearchParams(window.location.search);
// `?view=template-graphic&projectId=…&templateId=…` is one template's graphic,
// large and editable, in a tab of its own (TemplateGraphicPage).
const page = query.get('view') === 'templates'
  ? <TemplatesOverview projectId={query.get('projectId') ?? ''} />
  : query.get('view') === 'template-graphic'
    ? <TemplateGraphicPage projectId={query.get('projectId') ?? ''} templateId={query.get('templateId') ?? ''} />
    : <App />;

// The app's own message and question boxes — see AppDialog.tsx.
render(<>{page}<AppDialogHost /></>, document.getElementById('root'));