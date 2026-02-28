import { ObjectId } from 'mongodb';

export class ProjectService {
  constructor(database) {
    this.collection = database.collection('projects');
  }

  async getAllProjects() {
    try {
      const documents = await this.collection
        .find({})
        .sort({ changedOn: -1 })
        .toArray();
      return documents;
    } catch (error) {
      throw new Error(`Failed to fetch projects: ${error.message}`);
    }
  }

  async getProjectById(id) {
    try {
      const document = await this.collection.findOne({ _id: id });
      return document;
    } catch (error) {
      throw new Error(`Failed to fetch project: ${error.message}`);
    }
  }

  async getProjectByName(projectName) {
    try {
      const document = await this.collection.findOne({ projectName });
      return document;
    } catch (error) {
      throw new Error(`Failed to fetch project by name: ${error.message}`);
    }
  }

  async createProject(projectData) {
    try {
      const project = {
        ...projectData,
        createdOn: new Date().toISOString(),
        changedOn: new Date().toISOString()
      };
      
      const result = await this.collection.insertOne(project);
      const createdProject = await this.getProjectById(result.insertedId);
      return createdProject;
    } catch (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }
  }

  async updateProject(id, updateData) {
    try {
      const updatedData = {
        ...updateData,
        changedOn: new Date().toISOString()
      };

      const result = await this.collection.findOneAndUpdate(
        { _id: id },
        { $set: updatedData },
        { returnDocument: 'after' }
      );

      if (!result.value) {
        throw new Error('Project not found');
      }

      return result.value;
    } catch (error) {
      throw new Error(`Failed to update project: ${error.message}`);
    }
  }

  async deleteProject(id) {
    try {
      const result = await this.collection.deleteOne({ _id: id });
      if (result.deletedCount === 0) {
        throw new Error('Project not found');
      }
      return true;
    } catch (error) {
      throw new Error(`Failed to delete project: ${error.message}`);
    }
  }

  async searchProjects(searchTerm) {
    try {
      const query = {
        $or: [
          { projectName: { $regex: searchTerm, $options: 'i' } },
          { projectDescription: { $regex: searchTerm, $options: 'i' } },
          { client: { $regex: searchTerm, $options: 'i' } },
          { location: { $regex: searchTerm, $options: 'i' } }
        ]
      };

      const documents = await this.collection
        .find(query)
        .sort({ changedOn: -1 })
        .toArray();

      return documents;
    } catch (error) {
      throw new Error(`Failed to search projects: ${error.message}`);
    }
  }

  async exportAllProjects() {
    try {
      const projects = await this.getAllProjects();
      return projects;
    } catch (error) {
      throw new Error(`Failed to export projects: ${error.message}`);
    }
  }
}