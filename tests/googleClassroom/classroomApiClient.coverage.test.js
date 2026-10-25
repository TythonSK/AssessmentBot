import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withGlobalMocks } from '../helpers/globalMockManager.js';
import { loadSyntheticAnalysisProfile } from '#synthetic-data/loadSyntheticAnalysisProfile.js';

const ClassroomApiClient = require('#backend/GoogleClassroom/ClassroomApiClient.js');
const { Teacher } = require('#backend/Models/Teacher.js');
const { Student } = require('#backend/Models/Student.js');
const canonicalClass = loadSyntheticAnalysisProfile('small', 'classesById')['class-0'];

describe('ClassroomApiClient empty responses and failure boundaries', () => {
  let courses;
  let tracker;
  let logger;
  let restoreGlobals;

  beforeEach(() => {
    courses = {
      list: vi.fn(),
      Topics: { get: vi.fn() },
      Teachers: { list: vi.fn() },
      Students: { list: vi.fn() },
    };
    tracker = {
      logError: vi.fn(),
      logAndThrowError: vi.fn((message) => {
        throw new Error(message);
      }),
    };
    logger = { info: vi.fn() };
    ({ restore: restoreGlobals } = withGlobalMocks({
      Classroom: () => ({ Courses: courses }),
      ProgressTracker: () => ({ getInstance: () => tracker }),
      ABLogger: () => ({ getInstance: () => logger }),
      Teacher: () => Teacher,
      Student: () => Student,
    }));
  });

  afterEach(() => {
    restoreGlobals();
    vi.restoreAllMocks();
  });

  it('fetchClassrooms returns an empty list when the API omits courses', () => {
    courses.list.mockReturnValue({});

    expect(ClassroomApiClient.fetchClassrooms()).toEqual([]);

    expect(courses.list).toHaveBeenCalledExactlyOnceWith({
      teacherId: 'me',
      courseStates: ['ACTIVE'],
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('Fetched classrooms.', { count: 0 });
    expect(tracker.logAndThrowError).not.toHaveBeenCalled();
  });

  it('fetchClassrooms propagates a contextual error when the API fails', () => {
    const apiError = new Error('Permission denied');
    courses.list.mockImplementation(() => {
      throw apiError;
    });

    expect(() => ClassroomApiClient.fetchClassrooms()).toThrow(
      'Failed to fetch classrooms: Permission denied'
    );

    expect(tracker.logAndThrowError).toHaveBeenCalledExactlyOnceWith(
      'Failed to fetch classrooms: Permission denied',
      apiError
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('fetchTopicName returns null and logs the identifiers when the topic name is absent', () => {
    courses.Topics.get.mockReturnValue(null);

    expect(ClassroomApiClient.fetchTopicName('course-1', 'topic-1')).toBeNull();

    expect(courses.Topics.get).toHaveBeenCalledExactlyOnceWith('course-1', 'topic-1');
    expect(tracker.logError).toHaveBeenCalledExactlyOnceWith(
      'Topic name not found for provided course/topic.',
      { courseId: 'course-1', topicId: 'topic-1' }
    );
  });

  it('fetchTopicName logs context and rethrows the original API error', () => {
    const apiError = new Error('Topic unavailable');
    courses.Topics.get.mockImplementation(() => {
      throw apiError;
    });

    expect(() => ClassroomApiClient.fetchTopicName('course-1', 'topic-1')).toThrow(apiError);

    expect(tracker.logError).toHaveBeenCalledExactlyOnceWith(
      'Failed to fetch topic name from Classroom.',
      { courseId: 'course-1', topicId: 'topic-1', err: apiError }
    );
  });

  it('fetchTeachers returns an empty list for absent responses and omitted teacher lists', () => {
    courses.Teachers.list.mockReturnValueOnce(undefined).mockReturnValueOnce({});

    expect(ClassroomApiClient.fetchTeachers('course-1')).toEqual([]);
    expect(ClassroomApiClient.fetchTeachers('course-1')).toEqual([]);

    expect(courses.Teachers.list).toHaveBeenCalledTimes(2);
    expect(courses.Teachers.list).toHaveBeenNthCalledWith(1, 'course-1');
    expect(courses.Teachers.list).toHaveBeenNthCalledWith(2, 'course-1');
    expect(tracker.logError).not.toHaveBeenCalled();
  });

  it('fetchTeachers maps missing profile fields to null-valued Teacher instances', () => {
    courses.Teachers.list.mockReturnValue({ teachers: [null, { profile: {} }] });

    const result = ClassroomApiClient.fetchTeachers('course-1');

    expect(result).toHaveLength(2);
    for (const teacher of result) {
      expect(teacher).toBeInstanceOf(Teacher);
      expect(teacher).toEqual({ email: null, userId: null, teacherName: null });
    }
    expect(tracker.logError).not.toHaveBeenCalled();
  });

  it('fetchTeachers skips an unreadable resource without losing subsequent teachers', () => {
    const mappingError = new Error('Unreadable profile');
    const unreadableTeacher = {
      get profile() {
        throw mappingError;
      },
    };
    const teacher = canonicalClass.teachers[0];
    courses.Teachers.list.mockReturnValue({
      teachers: [
        unreadableTeacher,
        {
          profile: {
            id: teacher.userId,
            emailAddress: teacher.email,
            name: { fullName: teacher.teacherName },
          },
        },
      ],
    });

    const result = ClassroomApiClient.fetchTeachers(canonicalClass.classId);

    expect(result).toEqual([new Teacher(teacher.email, teacher.userId, teacher.teacherName)]);
    expect(result[0]).toBeInstanceOf(Teacher);
    expect(tracker.logError).toHaveBeenCalledExactlyOnceWith(
      `Failed to map teacher resource for course (${canonicalClass.classId}): Unreadable profile`,
      mappingError
    );
  });

  it('fetchTeachers logs the course and returns an empty list when the API fails', () => {
    const apiError = new Error('Teacher access denied');
    courses.Teachers.list.mockImplementation(() => {
      throw apiError;
    });

    expect(ClassroomApiClient.fetchTeachers('course-1')).toEqual([]);

    expect(courses.Teachers.list).toHaveBeenCalledExactlyOnceWith('course-1');
    expect(tracker.logError).toHaveBeenCalledExactlyOnceWith(
      'Failed to fetch teachers for course (course-1): Teacher access denied',
      apiError
    );
  });

  it('fetchAllStudents continues through omitted and empty student pages using each page token', () => {
    const student = canonicalClass.students[0];
    courses.Students.list
      .mockReturnValueOnce({ nextPageToken: 'empty-page' })
      .mockReturnValueOnce({ students: [], nextPageToken: 'last-page' })
      .mockReturnValueOnce({
        students: [
          {
            profile: {
              id: student.id,
              emailAddress: student.email,
              name: { fullName: student.name },
            },
          },
        ],
      });

    const result = ClassroomApiClient.fetchAllStudents(canonicalClass.classId);

    expect(result).toEqual([new Student(student.name, student.email, student.id)]);
    expect(result[0]).toBeInstanceOf(Student);
    expect(courses.Students.list).toHaveBeenCalledTimes(3);
    expect(courses.Students.list).toHaveBeenNthCalledWith(1, canonicalClass.classId, {
      pageSize: 40,
    });
    expect(courses.Students.list).toHaveBeenNthCalledWith(2, canonicalClass.classId, {
      pageSize: 40,
      pageToken: 'empty-page',
    });
    expect(courses.Students.list).toHaveBeenNthCalledWith(3, canonicalClass.classId, {
      pageSize: 40,
      pageToken: 'last-page',
    });
    expect(tracker.logError).not.toHaveBeenCalled();
  });

  it('fetchAllStudents discards a partial roster and logs when a later page fails', () => {
    const student = canonicalClass.students[0];
    const apiError = new Error('Quota exceeded');
    courses.Students.list
      .mockReturnValueOnce({
        students: [
          {
            profile: {
              id: student.id,
              emailAddress: student.email,
              name: { fullName: student.name },
            },
          },
        ],
        nextPageToken: 'second-page',
      })
      .mockImplementationOnce(() => {
        throw apiError;
      });

    expect(ClassroomApiClient.fetchAllStudents(canonicalClass.classId)).toEqual([]);

    expect(courses.Students.list).toHaveBeenCalledTimes(2);
    expect(courses.Students.list).toHaveBeenNthCalledWith(2, canonicalClass.classId, {
      pageSize: 40,
      pageToken: 'second-page',
    });
    expect(tracker.logError).toHaveBeenCalledExactlyOnceWith(
      `Error fetching students for course ID ${canonicalClass.classId}: Quota exceeded`,
      apiError
    );
  });
});
