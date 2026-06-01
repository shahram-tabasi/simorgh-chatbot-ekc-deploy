import React, { useState, createContext, useContext, ReactNode } from 'react';
import { ProjectData, TemplateItem, DeviceItem, Equipment, TemplateHierarchy } from '../types/project';
import { projectService } from '../services/projectService';

interface ProjectContextType {
  projectData: ProjectData;
  updateProjectData: (data: Partial<ProjectData>) => void;
  saveProject: () => Promise<void>;
  addTemplate: (type: 'LV' | 'MV' | 'HV', name: string, hierarchy?: TemplateHierarchy, copyFromId?: string) => void;
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

// EMPTY DEFAULTS. Previously this object was full of demo values
// ("New Project", "SIMORGH", standard "IEC", country "Iran", 20 kV MV,
// "Brown/Black/Grey", etc.). They leaked into every newly-opened project
// — even when the chatbot bridge sent specific extracted values, any
// missing keys fell back to the demo. Per requirements: rely on REAL
// data only. Nested keys are kept (empty) so existing UI components
// that read `projectData.technicalSettings.mediumVoltage.X` don't crash.
const defaultProjectData: ProjectData = {
  projectName: '',
  projectId: '',
  projectNumber: '',
  noticeToProceedDate: '',
  deliveryDate: '',
  projectDescription: '',
  planner: '',
  designOffice: '',
  createdOn: new Date().toLocaleDateString(),
  changedOn: new Date().toLocaleDateString(),
  location: '',
  client: '',
  standard: '',
  country: '',
  language: '',
  comment: '',
  technicalSettings: {
    mediumVoltage: {
      nominalVoltage: '',
      maxShortCircuitPower: '',
      minShortCircuitPower: '',
      maxCrossSection: '',
      minCrossSection: ''
    },
    lowVoltage: {
      nominalVoltage: '',
      frequency: '',
      permissibleTouchVoltage: '',
      ambientTemperature: '',
      numberOfPoles: '',
      earthFaultDetection: '',
      referencePoint: '',
      relativeOperatingVoltage: '',
      maxPermissibleVoltage: '',
      maxCrossSection: '',
      minCrossSection: '',
      enableReducedCrossSection: false
    }
  },
  techSettings: {
    general: { altitudeAboveSeaLevel: '', designTemperature: '' },
    wireSize: { controlCircuit: '', ctSecondary: '', ptSecondary: '', plcPowerSupply: '' },
    wireColor: { acPhase: '', dcPlus: '', acNeutral: '', dcMinus: '', plcInput: '', plcOutput: '', threePhase: '' },
    wireManufacturer: { lv: '', mv: '' },
    others: { thicknessOfPainting: '', colorType: '', backgroundColor: '', writingColor: '' }
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

  // Deep-link hydrate: the chatbot creates a project on simorgh-soft's
  // backend, then redirects the user to /simorgh-design-suite/?projectId=<_id>.
  // If we see that query param on mount AND we don't already have a project
  // loaded, fetch it and hydrate the context. One-shot — won't fight a
  // later in-app project switch.
  React.useEffect(() => {
    if (initialProject) return;
    try {
      const q = new URLSearchParams(window.location.search);
      const pid = q.get("projectId");
      if (!pid) return;
      (async () => {
        try {
          const p = await projectService.getProjectById(pid);
          if (p) {
            setProjectData({ ...defaultProjectData, ...p });
            setProjectId(pid);
          }
        } catch (e) {
          console.warn("deep-link hydrate failed:", e);
        }
      })();
    } catch { /* ignore: no window (SSR / test) */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const addTemplate = (
    type: 'LV' | 'MV' | 'HV',
    name: string,
    hierarchy?: TemplateHierarchy,
    copyFromId?: string,
  ) => {
    setProjectData(prev => {
      // Optional clone of an existing template's properties (deep enough for
      // our value tree). Used by the hierarchical wizard's "use as a starting
      // point" flow.
      let baseProps: Record<string, any> = {};
      if (copyFromId) {
        const source = prev.templates[type].find(t => t.id === copyFromId);
        if (source) baseProps = JSON.parse(JSON.stringify(source.properties || {}));
      }
      const newTemplate: TemplateItem = {
        id: `${type}-${Date.now()}`,
        name,
        type,
        properties: baseProps,
        ...(hierarchy ? { hierarchy } : {}),
      };
      return {
        ...prev,
        templates: {
          ...prev.templates,
          [type]: [...prev.templates[type], newTemplate],
        },
        changedOn: new Date().toISOString(),
      };
    });
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