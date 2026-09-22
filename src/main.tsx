import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';
import { FilterProvider } from './context/FilterContext';
import { ToastProvider } from './components/ui/Toast';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('CBO could not start: the #root element is missing from index.html.');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <FilterProvider>
            <App />
          </FilterProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
