#!/bin/bash

# Bunu çalıştırmadan önce:
# 1. GitHub'da yeni bir repo oluşturun
# 2. GITHUB_USER ve REPO_NAME değişkenlerini kendi değerlerinizle güncelleyin

# Bu değerleri kendi bilgilerinizle değiştirin
GITHUB_USER="KULLANICI_ADINIZ"
REPO_NAME="discord-nft-sales-bot"

# Git deposu başlat
echo "Git deposu başlatılıyor..."
git init

# Tüm dosyaları ekle
echo "Dosyalar git'e ekleniyor..."
git add .

# İlk commit
echo "İlk commit yapılıyor..."
git commit -m "Initial commit: Discord NFT Sales Bot"

# GitHub remote ekle
echo "GitHub remote ekleniyor..."
git remote add origin https://github.com/$GITHUB_USER/$REPO_NAME.git

# Main branch oluştur
git branch -M main

# GitHub'a push
echo "GitHub'a push yapılıyor..."
echo "NOT: GitHub kullanıcı adınız ve parolanız veya token'ınız sorulabilir"
git push -u origin main

echo "İşlem tamamlandı! Repo şu adreste: https://github.com/$GITHUB_USER/$REPO_NAME" 