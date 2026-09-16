import React from 'react';
import { TemplateItem } from '../../types/project';
import { templateMeta } from '../../utils/templateMeta';

interface DeviceListProps {
  templates: TemplateItem[];
  onDeviceSelect: (deviceId: string) => void;
  selectedDeviceId: string | null;
}

export const DeviceList: React.FC<DeviceListProps> = ({
  templates,
  onDeviceSelect,
  selectedDeviceId
}) => {
  return (
    <div className="space-y-2">
      {templates.map(template => (
        <div
          key={template.id}
          className={`p-2 border rounded cursor-pointer text-sm ${
            selectedDeviceId === template.id
              ? 'bg-blue-50 border-blue-300'
              : 'bg-white border-gray-200 hover:bg-gray-50'
          }`}
          onClick={() => onDeviceSelect(template.id)}
        >
          <div className="font-medium">{template.name}</div>
          <div className="text-xs text-gray-500 truncate">
            {template.type}{templateMeta(template) && ` · ${templateMeta(template)}`}
          </div>
        </div>
      ))}
    </div>
  );
};