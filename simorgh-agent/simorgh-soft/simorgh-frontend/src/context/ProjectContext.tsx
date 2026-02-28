import React, { useState, createContext, useContext, ReactNode } from 'react';
import { ProjectData, TemplateItem, DeviceItem, Equipment } from '../types/project';
import { projectService } from '../services/projectService';

interface ProjectContextType {
  projectData: ProjectData;
  updateProjectData: (data: Partial<ProjectData>) => void;
  saveProject: () => Promise<void>;
  addTemplate: (type: 'LV' | 'MV' | 'HV', name: string) => void;
  updateTemplate: (templateId: string, properties: Record<string, string>) => void;
  deleteTemplate: (templateId: string) => void;
  addDevice: (device: Partial<DeviceItem>) => void;
  updateDevice: (deviceId: string, data: Partial<DeviceItem>) => void;
  deleteDevice: (deviceId: string) => void;
  addEquipment: (equipment: Equipment) => void;
  updateEquipment: (equipmentId: string, data: Partial<Equipment>) => void;
  deleteEquipment: (equipmentId: string) => void;
  copyEquipment: (equipmentId: string) => void;
  selectedEquipment: Equipment | null;
  setSelectedEquipment: (equipment: Equipment | null) => void;
}

const defaultProjectData: ProjectData = {
  projectName: 'New Project',
  projectId: '',
  projectNumber: '',
  noticeToProceedDate: '',
  deliveryDate: '',
  projectDescription: 'Project Description',
  planner: 'SIMORGH',
  designOffice: 'ELECTRO KAVIR',
  createdOn: new Date().toLocaleDateString(),
  changedOn: new Date().toLocaleDateString(),
  location: '',
  client: '',
  standard: 'IEC',
  country: 'Iran',
  language: 'English',
  comment: '',
  technicalSettings: {
    mediumVoltage: {
      nominalVoltage: '20',
      maxShortCircuitPower: '250',
      minShortCircuitPower: '100',
      maxCrossSection: '500',
      minCrossSection: '25'
    },
    lowVoltage: {
      nominalVoltage: '400',
      frequency: '50',
      permissibleTouchVoltage: '50',
      ambientTemperature: '45',
      numberOfPoles: '3-contact preferably, 4-contact if required',
      earthFaultDetection: 'if required',
      referencePoint: 'Transformer-secondary terminals',
      relativeOperatingVoltage: '100',
      maxPermissibleVoltage: '14',
      maxCrossSection: '300',
      minCrossSection: '1.5',
      enableReducedCrossSection: false
    }
  },
  techSettings: {
    general: { altitudeAboveSeaLevel: '1000', designTemperature: '45' },
    wireSize: { controlCircuit: '1.5', ctSecondary: '2.5', ptSecondary: '2.5', plcPowerSupply: '1.5' },
    wireColor: { acPhase: 'Brown', dcPlus: 'Red', acNeutral: 'Blue', dcMinus: 'Black', plcInput: 'Green', plcOutput: 'Yellow', threePhase: 'Brown/Black/Grey' },
    wireManufacturer: { lv: '', mv: '' },
    others: { thicknessOfPainting: '80', colorType: 'RAL', backgroundColor: '7035', writingColor: '9005' }
  },
  templates: { LV: [], MV: [], HV: [] },
  deviceLibrary: { LV: [], MV: [], HV: [] },
  devices: [],
  equipments: [],
  outputTypes: []
};

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

interface ProjectProviderProps {
  children: ReactNode;
  initialProject?: ProjectData | null;
}

export const ProjectProvider: React.FC<ProjectProviderProps> = ({ children, initialProject }) => {
  // Merge supplied initial project with defaults so new/optional fields always exist
  const [projectData, setProjectData] = useState<ProjectData>(
    initialProject
      ? { ...defaultProjectData, ...initialProject }
      : defaultProjectData
  );
  const [projectId, setProjectId] = useState<string | null>(initialProject?._id || null);
  const [selectedEquipment, setSelectedEquipment] = useState<Equipment | null>(null); // ⭐ جدید

  const updateProjectData = (data: Partial<ProjectData>) => {
    setProjectData(prev => ({
      ...prev,
      ...data,
      changedOn: new Date().toISOString()
    }));
  };

  const saveProject = async (): Promise<void> => {
    try {
      console.log('Saving project...', projectData);
      
      const { _id, ...projectDataWithoutId } = projectData;
      const projectToSave = {
        ...projectDataWithoutId,
        changedOn: new Date().toISOString()
      };

      let savedProject;
      
      if (projectId) {
        console.log('Updating existing project with ID:', projectId);
        savedProject = await projectService.updateProject(projectId, projectToSave);
      } else {
        console.log('Creating new project');
        savedProject = await projectService.createProject(projectToSave);
        setProjectId(savedProject._id!);
      }

      setProjectData(savedProject);
      console.log('Project saved successfully:', savedProject);
    } catch (error) {
      console.error('Error saving project:', error);
      throw error;
    }
  };

  const addTemplate = (type: 'LV' | 'MV' | 'HV', name: string) => {
    const newTemplate: TemplateItem = {
      id: `${type}-${Date.now()}`,
      name,
      type,
      properties: {}
    };
    setProjectData(prev => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: [...prev.templates[type], newTemplate]
      },
      changedOn: new Date().toISOString()
    }));
  };

  const updateTemplate = (templateId: string, properties: Record<string, string>) => {
    setProjectData(prev => {
      const updatedTemplates = { ...prev.templates };
      for (const type of ['LV', 'MV', 'HV'] as const) {
        updatedTemplates[type] = updatedTemplates[type].map(template =>
          template.id === templateId ? { ...template, properties } : template
        );
      }
      return {
        ...prev,
        templates: updatedTemplates,
        changedOn: new Date().toISOString()
      };
    });
  };

  const deleteTemplate = (templateId: string) => {
    setProjectData(prev => {
      const updatedTemplates = { ...prev.templates };
      for (const type of ['LV', 'MV', 'HV'] as const) {
        updatedTemplates[type] = updatedTemplates[type].filter(
          template => template.id !== templateId
        );
      }
      return {
        ...prev,
        templates: updatedTemplates,
        changedOn: new Date().toISOString()
      };
    });
  };

  const addDevice = (device: Partial<DeviceItem>) => {
    const newDevice: DeviceItem = {
      id: `device-${Date.now()}`,
      rowNumber: projectData.devices.length + 1,
      deviceName: `Device ${projectData.devices.length + 1}`,
      templateId: '',
      flc: '',
      ratingPower: '',
      wiringType: '',
      feederNo: '',
      busSection: '',
      children: [],
      equipmentId: selectedEquipment?.id, // ⭐ ارتباط با Equipment انتخاب شده
      ...device
    };
    setProjectData(prev => ({
      ...prev,
      devices: [...prev.devices, newDevice],
      changedOn: new Date().toISOString()
    }));
  };

  const updateDevice = (deviceId: string, data: Partial<DeviceItem>) => {
    setProjectData(prev => ({
      ...prev,
      devices: prev.devices.map(device =>
        device.id === deviceId ? { ...device, ...data } : device
      ),
      changedOn: new Date().toISOString()
    }));
  };

  const deleteDevice = (deviceId: string) => {
    setProjectData(prev => ({
      ...prev,
      devices: prev.devices.filter(device => device.id !== deviceId),
      changedOn: new Date().toISOString()
    }));
  };

  // ⭐ جدید - Equipment Methods
  const addEquipment = (equipment: Equipment) => {
    setProjectData(prev => ({
      ...prev,
      equipments: [...prev.equipments, equipment],
      changedOn: new Date().toISOString()
    }));
  };

  const updateEquipment = (equipmentId: string, data: Partial<Equipment>) => {
    setProjectData(prev => ({
      ...prev,
      equipments: prev.equipments.map(eq =>
        eq.id === equipmentId ? { ...eq, ...data } : eq
      ),
      changedOn: new Date().toISOString()
    }));
  };

  const deleteEquipment = (equipmentId: string) => {
    // حذف دستگاه‌های مربوط به این Equipment
    setProjectData(prev => ({
      ...prev,
      equipments: prev.equipments.filter(eq => eq.id !== equipmentId),
      devices: prev.devices.filter(device => device.equipmentId !== equipmentId),
      changedOn: new Date().toISOString()
    }));
    
    if (selectedEquipment?.id === equipmentId) {
      setSelectedEquipment(null);
    }
  };

  const copyEquipment = (equipmentId: string) => {
    const equipment = projectData.equipments.find(eq => eq.id === equipmentId);
    if (equipment) {
      const copiedEquipment: Equipment = {
        ...equipment,
        id: `eq-${Date.now()}`,
        name: `${equipment.name} (Copy)`
      };
      addEquipment(copiedEquipment);
    }
  };

  return (
    <ProjectContext.Provider
      value={{
        projectData,
        updateProjectData,
        saveProject,
        addTemplate,
        updateTemplate,
        deleteTemplate,
        addDevice,
        updateDevice,
        deleteDevice,
        // ⭐ جدید
        addEquipment,
        updateEquipment,
        deleteEquipment,
        copyEquipment,
        selectedEquipment,
        setSelectedEquipment
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};