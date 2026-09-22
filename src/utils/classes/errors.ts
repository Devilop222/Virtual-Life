export abstract class AppError extends Error {
  public abstract readonly statusCode: number
  public abstract readonly isOperational: boolean

  constructor(
    message: string,
    public readonly persianMessage: string = 'خطایی در پردازش رخ داد؛ لطفاً دوباره تلاش کن.'
  ) {
    super(message)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class ValidationError extends AppError {
  public readonly statusCode = 400
  public readonly isOperational = true

  constructor(message: string, persianMessage?: string) {
    super(
      message,
      persianMessage || 'اطلاعات واردشده نامعتبر است؛ ورودیت را بررسی کن.'
    )
  }
}

export class NotFoundError extends AppError {
  public readonly statusCode = 404
  public readonly isOperational = true

  constructor(message: string, persianMessage?: string) {
    super(message, persianMessage || 'این مورد دیگر در دسترس نیست. فهرست همین بخش را به‌روزرسانی کن.')
  }
}

export class ConflictError extends AppError {
  public readonly statusCode = 409
  public readonly isOperational = true

  constructor(message: string, persianMessage?: string) {
    super(message, persianMessage || 'وضعیت تغییر کرده و این اقدام انجام نشد. پنل را به‌روزرسانی کن و دوباره انتخاب کن.')
  }
}

export class UnauthorizedError extends AppError {
  public readonly statusCode = 403
  public readonly isOperational = true

  constructor(message: string, persianMessage?: string) {
    super(message, persianMessage || 'دسترسی این اقدام را نداری. از پنل خودت استفاده کن یا شرایط بخش را در «راهنما» بخوان.')
  }
}

export class InternalServerError extends AppError {
  public readonly statusCode = 500
  public readonly isOperational = false

  constructor(message: string, persianMessage?: string) {
    super(message, persianMessage || 'خطای غیرمنتظره در سرور رخ داده است.')
  }
}
