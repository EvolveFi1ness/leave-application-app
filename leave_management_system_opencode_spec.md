# Leave Management System — OpenCode Project Specification

## 0. PROJECT OBJECTIVE

Build a complete Leave Application and HR Management System based on the reference screenshots and the Philippine Application for Leave form provided by the user.

The system must have two clearly separated interfaces:

1. **Employee Application**
2. **HR / Admin Application**

This must be a functional application, not a static/demo-only UI.

The system must support:

- Authentication
- Role-based access
- Employee leave applications
- Leave balances
- Leave validation
- Supporting documents
- Approval workflows
- HR review
- Approval/rejection
- Notifications
- Leave calendar
- Reports
- Audit logs
- Employee management
- Printable/PDF leave applications

---

# 1. REFERENCE DESIGN

Use the screenshots supplied by the user as the primary visual reference.

The visual style should follow:

- Dark navy header
- White/light background
- Indigo/purple primary actions
- Green for approved
- Yellow/orange for pending
- Red/pink for rejected
- Rounded cards
- Soft shadows
- Thin borders
- Large readable typography
- Clear section headings
- Modern professional HR application
- Mobile-first employee interface
- Responsive HR/admin interface

Do NOT blindly copy the screenshots.

Use them as design inspiration and create a coherent, production-quality UI.

The physical Philippine Application for Leave form should influence the application's fields and workflow.

The modern application UI and the generated printable government-style form are separate concerns:

- The app should be modern and easy to use.
- The generated PDF/printable document should follow the structure of the provided paper form.

---

# 2. IMPLEMENTATION BOUNDARY

## Employee Side

The employee application must include:

1. Login
2. Forgot Password
3. Home Dashboard
4. New Leave Application
5. Application Review
6. Application Submitted
7. My Requests
8. Request Details
9. Leave Calendar
10. Notifications
11. Profile

## HR/Admin Side

The HR/Admin application must include:

1. Admin Login
2. Dashboard
3. Applications
4. Application Review
5. Employees
6. Employee Details
7. Leave Balances
8. Leave Calendar
9. Reports
10. Audit Logs
11. Leave Types
12. Approval Workflow
13. Holidays
14. Admin/User Management
15. System Settings

Do not mix employee-only functionality with unrestricted administrator functionality.

Use role-based access control.

---

# 3. EMPLOYEE HOME DASHBOARD

The employee home screen should be based visually on the provided screenshots.

Display:

- Employee profile photo/avatar
- Employee name
- Department
- Position
- Annual leave balance
- Sick leave balance
- Personal leave balance
- Unpaid leave taken
- Pending applications
- Approved applications
- Rejected applications
- Upcoming approved leave

Example layout:

```text
STAFF PROFILE

Employee Name
Position
Department

LEAVE ALLOTMENT REMAINING

Annual Leave       Sick Leave
21 Days            12 Days

Personal Leave     Unpaid Taken
5 Days             0 Days

MY REQUEST TRACKING

All | Pending | History

Leave application cards
```

Use clear status badges.

---

# 4. EMPLOYEE NAVIGATION

Use a mobile-friendly bottom navigation.

Suggested navigation:

- Home
- Requests
- Calendar
- Notifications
- Profile

Provide a prominent "New Leave Application" action.

The navigation must preserve state correctly when switching tabs.

Avoid unnecessarily recreating screens or making expensive operations on every tab switch.

---

# 5. LEAVE APPLICATION

The application should be a structured multi-section form.

## Step 1 — Leave Category

Support configurable leave types including:

- Vacation Leave
- Sick Leave
- Maternity Leave
- Paternity Leave
- Special Privilege Leave
- Solo Parent Leave
- Study Leave
- 10-Day VAWC Leave
- Rehabilitation Privilege
- Special Leave Benefits for Women
- Special Emergency / Calamity Leave
- Adoption Leave
- Unpaid Leave
- Other

The administrator must be able to enable/disable leave types.

Do not hard-code leave types throughout the UI.

Use a configurable leave-type system.

---

# 6. DYNAMIC LEAVE DETAILS

The form must change depending on the selected leave type.

## Vacation Leave

Fields:

- Within the Philippines
- Abroad
- Country if abroad

Example:

```text
Where will you spend your leave?

○ Within the Philippines
○ Abroad

Country:
[________________________]
```

## Sick Leave

Fields:

- Hospital
- Out Patient
- Hospital/clinic
- Illness/reason

Example:

```text
Where were you confined?

○ Hospital
○ Out Patient

Hospital / Clinic:
[________________________]

Illness / Reason:
[________________________]
```

## Study Leave

Fields:

- Completion of Master's Degree
- BAR/Board Examination Review
- Other purpose
- Details

The system must support different required fields per leave type.

The admin should eventually be able to configure these fields.

---

# 7. ABSENCE INTERVAL

Include:

- Start Date
- End Date
- Automatically calculated working days

Example:

```text
START DATE                 END DATE

[ Aug 26, 2026 ]           [ Aug 26, 2026 ]

Number of working days:
1 DAY
```

Validation must include:

- End date cannot be before start date
- Detect overlapping leave
- Check available leave balance
- Respect configured holidays
- Calculate working days instead of simple calendar days
- Prevent invalid dates
- Handle weekends correctly
- Support Philippine holidays configured by the administrator

The working-day calculation must be centralized in business logic and not duplicated in UI code.

---

# 8. EMERGENCY CALLBACK CONTACT

Include:

- Contact Name
- Relationship
- Phone Number

Example:

```text
EMERGENCY CALLBACK CONTACT

Contact Name
[________________________]

Relationship
[ Parent ▼ ]

Phone Number
[________________________]
```

Validate phone number input.

---

# 9. LEAVE DETAILS / REASON

Include:

```text
DETAILS OF LEAVE

Reason for leave

[________________________________]
[________________________________]
[________________________________]

0 / 500 characters
```

Support configurable character limits.

Show validation errors clearly.

---

# 10. SUPPORTING DOCUMENTS

Allow employees to upload supporting documents.

Supported formats:

- PDF
- JPG
- JPEG
- PNG

Example:

```text
SUPPORTING DOCUMENTS

[ + Upload Document ]

Medical_Certificate.pdf
```

Support:

- Upload progress
- File validation
- File size validation
- Preview where supported
- Delete before submission
- Secure access control

Do not expose private documents publicly.

---

# 11. APPLICATION REVIEW

Before submitting, show a complete review screen.

Display:

- Employee information
- Leave type
- Leave dates
- Working days
- Leave-specific details
- Emergency contact
- Reason
- Supporting documents
- Expected leave balance after approval

Require explicit confirmation before submission.

Example:

```text
REVIEW APPLICATION

Employee
Kenneth Fajardo

Leave Type
Sick Leave

Date
August 26, 2026

Duration
1 Working Day

Emergency Contact
+63 9XX XXX XXXX

Reason
Medical appointment

Supporting Documents
medical_certificate.pdf

[ ] I confirm that the information provided is correct.

[ SUBMIT APPLICATION ]
```

---

# 12. APPLICATION STATUS

Supported statuses:

- DRAFT
- PENDING
- UNDER_REVIEW
- FOR_SUPERVISOR_REVIEW
- FOR_FINAL_APPROVAL
- APPROVED
- REJECTED
- CANCELLED

Show a visual timeline.

Example:

```text
APPLICATION STATUS

✓ Application Submitted
│
│ Aug 20, 2026
│
✓ HR Review
│
│ Aug 21, 2026
│
● Supervisor Review
│
│ Waiting
│
○ Final Approval
│
○ Completed
```

For rejected applications, show:

- Rejection reason
- Reviewer
- Date/time

---

# 13. MY REQUESTS

Create filters:

- All
- Pending
- History

Each request card should display:

- Leave type
- Status
- Start date
- End date
- Working days
- Short reason
- Submission date
- Actions allowed by status

Employees should be able to:

- Open application
- View details
- Cancel eligible pending applications

Do not allow cancellation after the application has reached a non-cancellable stage unless configured by HR.

---

# 14. LEAVE CALENDAR — EMPLOYEE

Show:

- Approved leave
- Pending leave
- Upcoming leave

Clearly differentiate statuses.

Allow the employee to open a calendar date and view their leave information.

---

# 15. NOTIFICATIONS

Employee notifications:

- Application submitted
- Application under review
- Application approved
- Application rejected
- Application cancelled
- Leave balance changed
- Application requires additional information

HR notifications:

- New leave application
- Application requiring review
- Application requiring approval
- Employee cancellation
- Other configurable events

Support in-app notifications first.

Push/email notifications can be implemented depending on backend capabilities.

---

# 16. HR ADMIN DASHBOARD

The HR dashboard should be based on the supplied screenshots.

Header:

```text
ADMIN PANEL

HR Administrator Name
Position
```

Dashboard cards:

```text
PENDING
8

APPROVED
2

REJECTED
0
```

Also display:

- Applications today
- Applications this week
- Employees currently on leave
- Upcoming leave
- Leave usage summary
- Departments with upcoming leave
- Applications requiring immediate attention

---

# 17. APPLICATION MANAGEMENT

HR must be able to:

- Search applications
- Filter applications
- Sort applications
- Filter by status
- Filter by employee
- Filter by department
- Filter by leave type
- Filter by date range
- Open applications
- View employee information
- View leave details
- View supporting documents
- View approval history
- Approve applications
- Reject applications
- Add review comments

Required filters:

```text
[ Search Employee ]

[ Pending ]
[ Approved ]
[ Rejected ]
[ All ]

Leave Type ▼
Department ▼
Date Range ▼
```

---

# 18. APPLICATION REVIEW SCREEN

The HR application review screen should display:

```text
EMPLOYEE

Kenneth Fajardo
Engineering
kenneth@example.com

SICK LEAVE

24 DAYS

Interval
June 30, 2026 → July 23, 2026

Emergency Contact
+63 9XX XXX XXXX

Reason
Medical leave due to illness

SUPPORTING DOCUMENTS

Medical_Certificate.pdf
[ View ]

HR REVIEW

Comments
[____________________________]

[ REJECT ]       [ APPROVE ]
```

Display all information needed for HR to make a decision.

Do not require HR to navigate through multiple screens just to understand one application.

---

# 19. APPROVAL

Approval must require confirmation.

Before approving, show:

- Employee
- Leave type
- Dates
- Working days
- Current balance
- Pending requests
- Remaining balance after approval

Example:

```text
APPROVE APPLICATION?

Sick Leave
Kenneth Fajardo

June 30 → July 23
24 working days

Current balance:
12 days

Balance after approval:
-12 days

WARNING:
Insufficient leave balance.

[ CANCEL ] [ CONTINUE ]
```

The system must enforce configured leave-balance rules.

Do not silently allow negative balances unless the organization explicitly allows it.

Approval must create an audit log.

---

# 20. REJECTION

Rejecting an application must require a reason.

Example:

```text
REJECT APPLICATION

Reason for rejection

[____________________________]
[____________________________]

[ ] Notify employee

[ CANCEL ] [ REJECT ]
```

Do not allow an empty rejection reason unless HR settings explicitly allow it.

---

# 21. EMPLOYEE MANAGEMENT

HR must be able to:

- Create employee
- Edit employee
- Disable employee
- View employee profile
- View department
- View position
- View leave balances
- View leave history

Employee profile should contain:

- Full name
- Employee ID
- Email
- Phone
- Department
- Position
- Employment status
- Date hired
- Leave balances
- Leave history

---

# 22. LEAVE BALANCE MANAGEMENT

Display:

- Earned
- Used
- Pending
- Remaining

Example:

```text
ANNUAL LEAVE

Earned:     25 days
Used:        3 days
Pending:     1 day
Remaining:  21 days
```

Authorized HR users may manually adjust balances.

Every adjustment must create an audit record containing:

- Admin
- Employee
- Previous balance
- New balance
- Difference
- Reason
- Timestamp

Do not allow ordinary employees to modify balances.

---

# 23. LEAVE CALENDAR — HR

Create an organization-wide leave calendar.

HR can filter by:

- Department
- Employee
- Leave type
- Status
- Date

Example:

```text
SEPTEMBER 2026

MON TUE WED THU FRI SAT SUN
     1   2   3   4   5   6
 7   8   9  10  11  12  13
14  15  16  17  18  19  20
21  22  23  24  25  26  27
28  29  30
```

Selecting a day should show employees on leave.

Example:

```text
SEPTEMBER 23

Employees on Leave

Sick Leave
Kenneth Fajardo

Vacation Leave
Maria Santos

Personal Leave
John Cruz
```

---

# 24. REPORTS

Create a reports section.

Report types:

- Monthly leave report
- Employee leave history
- Department leave report
- Leave type usage
- Sick leave report
- Vacation leave report
- Pending applications
- Approved applications
- Rejected applications
- Leave balance report

Filters:

- Date range
- Department
- Employee
- Leave type
- Status

Export formats:

- PDF
- Excel
- CSV

Reports must use the same underlying data as the application system.

Do not create fake report data.

---

# 25. AUDIT LOG

Create a complete audit log.

Log:

- Login
- Logout
- Application submitted
- Application edited
- Application cancelled
- Application approved
- Application rejected
- Leave balance changed
- Employee created
- Employee modified
- Employee disabled
- Document uploaded
- Document viewed
- Report generated
- Admin settings changed
- Leave type changed
- Approval workflow changed

Each audit record should contain:

- Actor
- Action
- Entity
- Entity ID
- Description
- Timestamp
- Relevant metadata when appropriate

Normal users must not be able to modify audit logs.

---

# 26. PRINTABLE GOVERNMENT-STYLE LEAVE FORM

Create a printable/PDF representation based on the provided Philippine Application for Leave form.

Populate:

- Office/Department
- Employee name
- Date of filing
- Position
- Salary if configured
- Type of leave
- Leave details
- Number of working days
- Inclusive dates
- Commutation
- Leave credit certification
- HR recommendation
- Approval/disapproval information

The generated document should follow the structure of the reference form.

However, do not hard-code organization-specific information.

Make organization information configurable.

Allow:

- Preview
- Print
- Generate PDF
- Download generated document

---

# 27. APPROVAL WORKFLOW

Support configurable approval levels.

Example:

```text
EMPLOYEE
   ↓
HR REVIEW
   ↓
SUPERVISOR REVIEW
   ↓
FINAL APPROVER
   ↓
APPROVED
```

The administrator should be able to configure whether a leave type requires:

- HR only
- HR + Supervisor
- HR + Supervisor + Final Approver

Store every approval action separately.

Never overwrite previous approval history.

---

# 28. USER ROLES

Implement role-based access control.

Roles:

- Employee
- Supervisor
- HR Staff
- HR Administrator
- Final Approver
- System Administrator

Each role should have explicit permissions.

Example:

Employee:
- Create own application
- View own applications
- View own leave balance
- Cancel eligible applications

Supervisor:
- Review assigned applications

HR Staff:
- Review applications
- View employees
- Manage appropriate HR records

HR Administrator:
- Full HR management
- Leave configuration
- Workflow configuration
- Reports
- Audit logs

System Administrator:
- System configuration
- User/role management
- Technical administration

Do not rely only on hiding UI buttons for security. Enforce permissions in the backend/data layer as well.

---

# 29. HOLIDAY MANAGEMENT

Create an HR holiday management screen.

HR can:

- Add holiday
- Edit holiday
- Delete/deactivate holiday
- Mark regular/special holiday
- Add description

The working-day calculator must use configured holidays.

Example:

```text
HOLIDAYS

August 21, 2026
Ninoy Aquino Day

August 31, 2026
National Heroes Day
```

Do not hard-code holidays into the core calculation logic.

---

# 30. DATABASE / DOMAIN MODEL

Use a proper normalized data model.

Suggested entities:

```text
users
employees
departments
positions

leave_types
leave_type_fields
leave_balances
leave_balance_transactions

leave_applications
leave_application_details

leave_approvals
approval_steps

supporting_documents

notifications

audit_logs

holidays

system_settings
roles
permissions
role_permissions
```

A leave application should contain information similar to:

```text
application_id
employee_id
leave_type_id
start_date
end_date
working_days
reason
emergency_contact
status
submitted_at
updated_at
```

Approval history:

```text
approval_id
application_id
approver_id
step_id
action
comment
timestamp
```

Leave balance transactions should track credits/debits rather than only storing one mutable balance number.

---

# 31. DATA INTEGRITY

The backend must enforce:

- Valid employee
- Valid leave type
- Valid date range
- Valid working-day calculation
- No unauthorized balance modifications
- No unauthorized approvals
- No unauthorized document access
- No duplicate conflicting approvals
- No invalid status transitions
- No orphaned application records

Use transactions for important multi-record operations.

For example, approval should update the application status and leave balance transaction atomically.

---

# 32. APPLICATION STATUS TRANSITIONS

Do not allow arbitrary status changes.

Use controlled transitions.

Example:

```text
DRAFT
  ↓
PENDING
  ↓
UNDER_REVIEW
  ↓
FOR_SUPERVISOR_REVIEW
  ↓
FOR_FINAL_APPROVAL
  ↓
APPROVED
```

Alternative path:

```text
PENDING
  ↓
REJECTED
```

Employee cancellation:

```text
PENDING / UNDER_REVIEW
  ↓
CANCELLED
```

Only authorized roles may perform each transition.

---

# 33. ERROR / EMPTY / LOADING STATES

Every major screen must have:

- Loading state
- Empty state
- Error state
- Retry state
- Success feedback

Examples:

```text
No applications found.

You don't have any leave requests yet.

[ CREATE LEAVE APPLICATION ]
```

Do not leave blank screens.

---

# 34. SECURITY

Protect:

- Employee personal information
- Leave information
- Medical information
- Uploaded documents
- HR records
- Audit logs

Use:

- Authentication
- Authorization
- Role-based access
- Secure document access
- Input validation
- Server-side validation
- Secure session handling

Never trust client-side validation alone.

---

# 35. PERFORMANCE

The application should remain responsive.

Avoid:

- Reloading all applications on every screen change
- Re-fetching unchanged data unnecessarily
- Recreating large lists unnecessarily
- Loading every supporting document immediately
- Performing heavy calculations on the UI thread

Use:

- Pagination
- Lazy loading
- Caching where appropriate
- Debounced search
- Efficient list rendering
- Background processing for heavy operations

The employee application should feel fast when switching tabs.

---

# 36. CODE ARCHITECTURE

Use clean, maintainable architecture.

Separate:

- UI
- State management
- Domain/business logic
- Data access
- Authentication
- Validation
- File handling
- Notifications
- PDF generation
- Reporting

Create reusable components for:

- Leave cards
- Status badges
- Date selectors
- Employee cards
- Application cards
- Confirmation dialogs
- Empty states
- Loading states
- Error states
- Document cards
- Dashboard statistics

Do not duplicate business logic across screens.

---

# 37. IMPLEMENTATION RULES FOR OPENCODE

Before changing code:

1. Inspect the existing project.
2. Understand the current architecture.
3. Identify the application framework and backend.
4. Inspect existing dependencies.
5. Inspect existing navigation.
6. Inspect existing authentication.
7. Inspect existing database/backend integration.
8. Identify reusable components.
9. Identify existing problems before replacing code.

Do NOT blindly rewrite the project.

Do NOT remove working functionality unless it is necessary.

Do NOT introduce duplicate systems.

Do NOT create fake backend responses when a real backend exists.

Do NOT create placeholder buttons that do nothing.

Every visible action must either work or clearly indicate that it is intentionally unavailable/configurable.

---

# 38. REQUIRED DEVELOPMENT PROCESS

Work incrementally.

For each major feature:

1. Inspect relevant existing code.
2. Plan the implementation.
3. Implement the feature.
4. Run formatting/linting if available.
5. Build the project.
6. Run tests if available.
7. Run the application.
8. Verify the UI.
9. Fix errors.
10. Review the changed code.
11. Only then continue to the next feature.

If an Android emulator/device is available, use it to test the actual application.

Use ADB where appropriate.

Test:

- Navigation
- Form input
- Date selection
- Validation
- Submission
- Approval
- Rejection
- Notifications
- Role restrictions
- Back navigation
- Screen rotation/responsive behavior where applicable

---

# 39. UI/UX QUALITY REQUIREMENTS

The application should feel like a real production HR application.

Prioritize:

- Clear hierarchy
- Consistent spacing
- Consistent typography
- Consistent button styles
- Accessible contrast
- Large touch targets
- Clear status indicators
- Good empty states
- Good error messages
- Good loading states
- Smooth navigation
- Responsive layouts

Do not overuse animations.

Animations should communicate state changes and navigation rather than distract from the workflow.

---

# 40. REFERENCE SCREEN DETAILS

Use the supplied screenshots for inspiration for:

- Employee profile header
- Leave balance cards
- Request cards
- Status badges
- HR dashboard
- Application review card
- Approval/rejection controls
- Empty states
- Filter controls
- Dark navy header
- Indigo primary buttons
- Rounded cards

The physical form supplied by the user should be used as the reference for the actual leave information and approval structure.

---

# 41. IMPORTANT BUSINESS RULES

Implement these rules centrally:

1. Working days exclude weekends.
2. Configured holidays are excluded.
3. Leave balances are checked before approval.
4. Pending leave should not automatically deduct final leave balance unless configured.
5. Approved leave must create a leave-balance transaction.
6. Rejected leave must not deduct leave balance.
7. Cancelled approved leave must have a defined reversal process.
8. Overlapping leave must be detected.
9. Approval history must never be overwritten.
10. Rejection requires a reason.
11. Manual balance adjustments require a reason.
12. Unauthorized users cannot approve/reject.
13. Employees can only access their own applications.
14. HR users can only access data allowed by their role.
15. Supporting documents must be access-controlled.
16. Audit logs must be append-only for normal users.

---

# 42. ADMIN SETTINGS

Create configurable settings for:

- Organization name
- Organization logo
- Office/department
- Leave types
- Leave type requirements
- Leave balances
- Approval workflow
- Holidays
- Working days
- Application cancellation rules
- Document upload limits
- Notification settings
- User roles
- Permissions

Avoid hard-coding organization-specific information.

---

# 43. TESTING CHECKLIST

Before declaring the project complete, verify:

## Authentication

- Employee login works
- HR login works
- Invalid credentials are handled
- Logout works
- Session persistence works
- Unauthorized users cannot access admin

## Employee

- Dashboard loads
- Leave balances load
- Leave application opens
- Leave types work
- Dynamic fields work
- Date picker works
- Working-day calculation works
- Validation works
- Documents upload
- Review page works
- Submission works
- Request tracking works
- Cancellation works where permitted
- Notifications work
- Profile works

## HR

- Dashboard works
- Application filters work
- Application details work
- Documents can be securely viewed
- Approval works
- Rejection works
- Comments work
- Employee management works
- Balance management works
- Calendar works
- Reports work
- Audit log works
- Settings work

## Workflow

Test:

```text
Employee submits
→ HR reviews
→ Approves

Employee submits
→ HR rejects
```

Also test:

```text
Employee submits
→ HR review
→ Supervisor review
→ Final approval
→ Approved
```

---

# 44. FINAL REVIEW REQUIREMENT

Before considering the project complete, perform a full project audit.

Review:

- Every screen
- Every route
- Every button
- Every form
- Every validation rule
- Every API/data operation
- Every database operation
- Every role permission
- Every status transition
- Every loading state
- Every empty state
- Every error state
- Every document operation
- Every notification
- Every report
- Every audit event

Find:

- Bugs
- Dead code
- Duplicate code
- Unused dependencies
- Unused components
- Incorrect state handling
- Security problems
- Performance problems
- Navigation problems
- UI inconsistencies
- Missing validation
- Missing error handling

Then fix the issues.

Use the appropriate code-quality/refactoring skills available in the project to simplify duplicated or unnecessarily complex code, but NEVER sacrifice readability or required functionality merely to reduce line count.

Do not perform blind "minification" of source code.

---

# 45. MANDATORY OPENCODE RULE

**MAKE NO MISTAKE ALWAYS REVIEW CODE BEFORE CHANGING.**

Before modifying a file, understand what the existing code does.

After modifying a file, review the complete changed section and verify that existing functionality has not been unintentionally broken.

Do not assume code is correct simply because it compiles.

---

# 46. DEFINITION OF DONE

The project is not complete merely because the screens exist.

It is complete when:

- Employee authentication works.
- HR authentication works.
- Roles work.
- Employees can submit real leave applications.
- Leave applications persist.
- Leave balances are calculated correctly.
- Working days are calculated correctly.
- HR can review applications.
- HR can approve applications.
- HR can reject applications.
- Rejection reasons are stored.
- Approval history is stored.
- Supporting documents are protected.
- Notifications work.
- Calendar works.
- Reports use real data.
- Audit logs work.
- Government-style leave PDF can be generated.
- Admin settings work.
- Validation works.
- Error states work.
- The application survives normal navigation without losing state.
- The application has been built and tested.
- The code has been reviewed after implementation.

Do not mark a feature as complete if it only has a visual placeholder.
