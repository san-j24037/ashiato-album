type GoogleIdentityResponse = { credential: string }
type GoogleTokenResponse = { access_token: string; expires_in: number; error?: string }

interface GoogleIdentity {
  accounts: {
    id: {
      initialize(options: {
        client_id: string
        callback(response: GoogleIdentityResponse): void
        auto_select?: boolean
      }): void
      renderButton(element: HTMLElement, options: Record<string, string | number>): void
      prompt(): void
    }
    oauth2: {
      initTokenClient(options: {
        client_id: string
        scope: string
        callback(response: GoogleTokenResponse): void
      }): { requestAccessToken(options?: { prompt?: string }): void }
    }
  }
}

interface Window {
  google?: GoogleIdentity
}
