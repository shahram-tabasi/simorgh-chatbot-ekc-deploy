import React, { Fragment } from 'react';
interface Tab {
  id: number;
  title: string;
  component: React.ReactNode;
}
interface TabNavigationProps {
  tabs: Tab[];
  activeTab: number;
  onTabChange: (tabId: number) => void;
}
export const TabNavigation: React.FC<TabNavigationProps> = ({
  tabs,
  activeTab,
  onTabChange
}) => {
  return <div className="flex items-center border-b-2 border-gray-200 mb-4">
      {tabs.map((tab, index) => <Fragment key={tab.id}>
          <div className={`flex items-center ${index === activeTab ? 'text-blue-600 font-bold' : 'text-gray-600'} cursor-pointer`} onClick={() => onTabChange(index)}>
            <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-current mr-2">
              {index + 1}
            </div>
            <span>{tab.title}</span>
          </div>
          {index < tabs.length - 1 && <div className="flex-grow mx-4 border-t-2 border-gray-300"></div>}
        </Fragment>)}
    </div>;
};